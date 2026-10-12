import {
  type ApiClient,
  gateOf,
  invalidateOverseerEvent,
  openGatesKey,
  overseerKeyPrefix,
} from '@dispatch/client';
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';

const key = (port: number, name: string) => ['tui', port, name] as const;

// A failed query's message, for the status line.
const problem = (err: unknown): string | null => {
  if (err === null || err === undefined) return null;
  return err instanceof Error ? err.message : 'request failed';
};

/** Tasks, runs, open asks and captured notes, refetched whenever dispatchd says they changed. */
export function useDaemonData(
  client: ApiClient,
  port: number,
  canDecide: boolean
) {
  const tasks = useQuery({
    queryKey: key(port, 'tasks'),
    queryFn: () => client.fetchTasks(),
  });
  const runs = useQuery({
    queryKey: key(port, 'runs'),
    queryFn: () => client.fetchRuns(),
  });
  const decisions = useQuery({
    queryKey: key(port, 'decisions'),
    queryFn: () => client.openDecisions(),
    // The decision feed is human-tier; the agent token would only earn a 403.
    enabled: canDecide,
  });
  const inbox = useQuery({
    queryKey: key(port, 'inbox'),
    queryFn: () => client.fetchInbox(),
  });
  // Overseer gates render as cards in the conversation, not as asks in Coming in.
  const asks = (decisions.data?.items ?? []).filter(
    (m) => gateOf(m)?.type.startsWith('overseer') !== true
  );
  return {
    tasks: tasks.data ?? [],
    runs: runs.data ?? [],
    asks,
    inbox: inbox.data ?? [],
    error:
      problem(runs.error) ??
      problem(tasks.error) ??
      problem(decisions.error) ??
      problem(inbox.error),
  };
}

/** The run's diff, fetched only while it is on screen. */
export function useRunDiff(
  client: ApiClient,
  port: number,
  runId: string | null
) {
  return useQuery({
    queryKey: [...key(port, 'diff'), runId],
    queryFn: () => client.fetchRunDiff(runId ?? ''),
    enabled: runId !== null,
  });
}

/** Marks stale exactly what one dispatchd event touched; one socket feeds the whole TUI. */
export function applyEvent(
  queryClient: QueryClient,
  port: number,
  type: string,
  conversationId?: string
) {
  const refetch = (name: string) =>
    void queryClient.invalidateQueries({ queryKey: key(port, name) });
  if (type === 'task.changed') refetch('tasks');
  else if (type === 'run.changed') {
    refetch('runs');
    refetch('diff');
  } else if (type === 'inbox.changed') refetch('inbox');
  else if (
    type === 'message.new' ||
    type === 'delivery.changed' ||
    type === 'decisions.changed'
  ) {
    // A run asking, an answer landing anywhere, or the feed itself moving.
    refetch('decisions');
  } else if (type === 'overseer.changed' && conversationId !== undefined) {
    invalidateOverseerEvent(queryClient, port, conversationId);
    refetch('decisions');
  } else if (type === 'hello') {
    // A (re)connect usually means dispatchd restarted: its in-memory records are gone too.
    void queryClient.invalidateQueries({ queryKey: ['tui', port] });
    void queryClient.invalidateQueries({ queryKey: overseerKeyPrefix(port) });
    void queryClient.invalidateQueries({ queryKey: openGatesKey(port) });
  }
}

export function useDaemonEvents(client: ApiClient, port: number) {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      client.connectEvents(() => {}, {
        onEvent: (event) =>
          applyEvent(
            queryClient,
            port,
            event.type,
            'conversationId' in event ? event.conversationId : undefined
          ),
      }),
    [client, port, queryClient]
  );
}
