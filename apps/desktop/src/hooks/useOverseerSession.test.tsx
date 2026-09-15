import {
  type ApiClient,
  ApiError,
  type OverseerRecord,
} from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';
import type { ReactNode } from 'react';

import {
  overseerKey,
  overseerKeyPrefix,
  useOverseerSession,
} from './useOverseerSession';

const PORT = 4321;

function overseerRecord(): OverseerRecord {
  return {
    id: 'w-1',
    prompt: 'what is going on?',
    backendName: 'fake',
    state: 'ready',
    messages: [],
    pendingActions: [
      {
        id: 'act-1',
        tool: 'cancel_run',
        input: { runId: 'r-1' },
        summary: 'Cancel run r-1',
        createdAt: '2026-08-10T00:00:02Z',
        status: 'pending',
      },
    ],
    pendingApprovals: [],
    undeliveredDecisions: [],
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:00:05Z',
  };
}

// Only the two calls this hook makes on the path under test: `start` seeds the
// cache with a real record, then every refetch fails the way the test wants.
function stubClient(refetchError: unknown): ApiClient {
  return {
    baseUrl: `http://127.0.0.1:${PORT}`,
    startOverseer: () => Promise.resolve(overseerRecord()),
    getOverseer: () => Promise.reject(refetchError),
  } as unknown as ApiClient;
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// Opens a conversation (which caches the record `startOverseer` returned) and
// waits for the follow-up refetch to fail, leaving the hook in the one state
// the two tests below disagree about: cached record + non-null error.
async function sessionAfterFailedRefetch(refetchError: unknown) {
  const { result } = renderHook(
    () => useOverseerSession(stubClient(refetchError), PORT, '/repo'),
    { wrapper }
  );
  await act(async () => {
    await result.current.submit('what is going on?');
  });
  await waitFor(() => {
    expect(result.current.recordError).not.toBeNull();
  });
  return result;
}

// The ghost direction: overseer records live in an in-memory Map, so a daemon
// restart 404s every id. The cached record and its pendingActions describe a
// conversation that no longer exists anywhere and must not reach any consumer.
test('a 404 on refetch drops the cached record', async () => {
  const result = await sessionAfterFailedRefetch(
    new ApiError('overseer conversation w-1 not found', 404)
  );
  expect(result.current.record).toBeUndefined();
  expect(result.current.recordError).toBe(
    'overseer conversation w-1 not found'
  );
});

// The opposite direction, and the reason this cannot be a blanket
// `recordError !== null` veto: a transient failure leaves the conversation —
// and any mutation queued on it — very much alive server-side.
test('a 500 on refetch keeps the cached record and its pending actions', async () => {
  const result = await sessionAfterFailedRefetch(
    new ApiError('daemon busy', 500)
  );
  expect(result.current.record?.id).toBe('w-1');
  expect(result.current.record?.pendingActions).toHaveLength(1);
});

// A network failure throws a plain TypeError, not an ApiError — no status to
// read, so it takes the same "assume it's still there" branch as a 5xx.
test('a network failure keeps the cached record', async () => {
  const result = await sessionAfterFailedRefetch(new TypeError('fetch failed'));
  expect(result.current.record?.id).toBe('w-1');
});

// The approval lock belongs to the session for the same reason the draft does.
// Approving runs the real mutation before the call resolves, and every surface
// that renders a confirm card is unmounted by an ordinary tab flip — so the
// flag has to be raised for the whole call, on state that outlives the chat.
test('the deciding action is exposed while a confirm is in flight', async () => {
  let settle: ((rec: OverseerRecord) => void) | undefined;
  const client = {
    baseUrl: `http://127.0.0.1:${PORT}`,
    startOverseer: () => Promise.resolve(overseerRecord()),
    getOverseer: () => Promise.resolve(overseerRecord()),
    confirmOverseerAction: () =>
      new Promise<OverseerRecord>((resolve) => {
        settle = resolve;
      }),
  } as unknown as ApiClient;

  const { result } = renderHook(
    () => useOverseerSession(client, PORT, '/repo'),
    {
      wrapper,
    }
  );
  await act(async () => {
    await result.current.submit('what is going on?');
  });
  expect(result.current.decidingActionId).toBeNull();

  let decided: Promise<void> | undefined;
  act(() => {
    decided = result.current.confirmAction('act-1', true);
  });
  // Mid-flight: the server is running the effect, so every card must stay
  // locked no matter how many times the chat around it has been remounted.
  expect(result.current.decidingActionId).toBe('act-1');

  await act(async () => {
    settle?.(overseerRecord());
    await decided;
  });
  expect(result.current.decidingActionId).toBeNull();
});

// The draft belongs to the session so it can outlive the components that
// render it, but not the conversation it was typed into: reset() is the "start
// over" control, and carrying a half-typed follow-up into the opening
// composer would put words in the next conversation's mouth.
test('reset clears the composer draft along with the conversation', () => {
  const { result } = renderHook(
    () =>
      useOverseerSession(stubClient(new ApiError('gone', 404)), PORT, '/repo'),
    { wrapper }
  );
  act(() => {
    result.current.setDraft('half a thought');
  });
  expect(result.current.draft).toBe('half a thought');

  act(() => {
    result.current.reset();
  });
  expect(result.current.draft).toBe('');
  expect(result.current.conversationId).toBeNull();
});

// A dispatchd restart destroys every overseer record (they live in an in-memory
// Map), and nothing in the app notices on its own: `overseer.changed` can never
// arrive for a conversation the daemon no longer has, and the record query has
// no refetch interval. The trigger is the daemon's `hello` frame, which the
// server sends from its websocket `open` handler and so on every reconnect;
// useDispatchProject handles it and cannot name a conversation id — it does
// not own this session — so it invalidates by prefix. This is that chain's far
// end: once the prefix invalidation fires, the ghost record and the pending
// action nobody can decide any more have to be gone.
test('a prefix invalidation clears a record the daemon no longer has', async () => {
  let restarted = false;
  const client = {
    baseUrl: `http://127.0.0.1:${PORT}`,
    startOverseer: () => Promise.resolve(overseerRecord()),
    getOverseer: () =>
      restarted
        ? Promise.reject(
            new ApiError('overseer conversation w-1 not found', 404)
          )
        : Promise.resolve(overseerRecord()),
  } as unknown as ApiClient;

  // This test's own client, not the shared `wrapper`: it has to invalidate the
  // same cache the hook reads, which the per-render wrapper hides.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { result } = renderHook(
    () => useOverseerSession(client, PORT, '/repo'),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    }
  );
  await act(async () => {
    await result.current.submit('what is going on?');
  });
  await waitFor(() => {
    expect(result.current.record?.pendingActions).toHaveLength(1);
  });

  restarted = true;
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: overseerKeyPrefix(PORT) });
  });

  await waitFor(() => {
    expect(result.current.record).toBeUndefined();
  });
  expect(result.current.recordError).toBe(
    'overseer conversation w-1 not found'
  );
});

// The prefix above only reaches the record query if the full key still starts
// with it. Nothing else would catch a reshuffle of overseerKey's elements: the
// invalidation would quietly stop matching and the ghost would come back.
test('the record key starts with the prefix the hello handler invalidates', () => {
  expect(overseerKey(PORT, 'w-1').slice(0, 2)).toEqual([
    ...overseerKeyPrefix(PORT),
  ]);
});

// The send's error and in-flight flag belong to the session for the same
// reason the draft and the approval lock do: the rail drops the chat's whole
// panel on a tab flip, so a failure reported into component state lands on an
// unmounted component and is never seen. Flipping to Runs to watch the turn is
// the path the feature encourages, which makes this the likely case, not a
// corner one.
test('a failed submit leaves its error and the typed text on the session', async () => {
  const client = {
    baseUrl: `http://127.0.0.1:${PORT}`,
    startOverseer: () => Promise.reject(new Error('dispatchd refused it')),
  } as unknown as ApiClient;

  const { result } = renderHook(
    () => useOverseerSession(client, PORT, '/repo'),
    {
      wrapper,
    }
  );
  act(() => {
    result.current.setDraft('what is going on?');
  });

  await act(async () => {
    await result.current.submit('what is going on?');
  });

  expect(result.current.sendError).toBe('dispatchd refused it');
  expect(result.current.sending).toBe(false);
  // Cleared before the call so a slow round trip cannot eat it, put back on
  // failure — the human should not have to retype the question.
  expect(result.current.draft).toBe('what is going on?');
  expect(result.current.conversationId).toBeNull();
});

// The flag has to be readable *during* the call, not just settled afterwards:
// it is what disables Send, and a chat remounted mid-flight (tab flip, rail
// collapse) must come back with the button still disabled.
test('the in-flight flag is raised for the whole submit', async () => {
  let settle: ((rec: OverseerRecord) => void) | undefined;
  const client = {
    baseUrl: `http://127.0.0.1:${PORT}`,
    startOverseer: () =>
      new Promise<OverseerRecord>((resolve) => {
        settle = resolve;
      }),
    getOverseer: () => Promise.resolve(overseerRecord()),
  } as unknown as ApiClient;

  const { result } = renderHook(
    () => useOverseerSession(client, PORT, '/repo'),
    {
      wrapper,
    }
  );
  expect(result.current.sending).toBe(false);

  let submitted: Promise<void> | undefined;
  act(() => {
    submitted = result.current.submit('what is going on?');
  });
  expect(result.current.sending).toBe(true);

  await act(async () => {
    settle?.(overseerRecord());
    await submitted;
  });
  expect(result.current.sending).toBe(false);
  expect(result.current.sendError).toBeNull();
});

// reset() is the "start over" control, so it clears the last failure with the
// conversation — a stale error banner over a fresh composer is a lie.
test('reset clears the last send error', async () => {
  const client = {
    baseUrl: `http://127.0.0.1:${PORT}`,
    startOverseer: () => Promise.reject(new Error('dispatchd refused it')),
  } as unknown as ApiClient;

  const { result } = renderHook(
    () => useOverseerSession(client, PORT, '/repo'),
    {
      wrapper,
    }
  );
  await act(async () => {
    await result.current.submit('what is going on?');
  });
  expect(result.current.sendError).toBe('dispatchd refused it');

  act(() => {
    result.current.reset();
  });
  expect(result.current.sendError).toBeNull();
});

// The other half of clearing the draft up front: the restore must not clobber
// what the human typed while the call was in flight. `submit` puts the text
// back only when the composer is still empty.
test('a failed submit leaves a newly typed draft alone', async () => {
  let reject: ((err: Error) => void) | undefined;
  const client = {
    baseUrl: `http://127.0.0.1:${PORT}`,
    startOverseer: () =>
      new Promise<OverseerRecord>((_resolve, rej) => {
        reject = rej;
      }),
  } as unknown as ApiClient;

  const { result } = renderHook(
    () => useOverseerSession(client, PORT, '/repo'),
    {
      wrapper,
    }
  );

  let submitted: Promise<void> | undefined;
  act(() => {
    submitted = result.current.submit('what is going on?');
  });
  // The sent text is gone the moment it is handed off, not a round trip later.
  expect(result.current.draft).toBe('');

  act(() => {
    result.current.setDraft('next thought');
  });
  await act(async () => {
    reject?.(new Error('daemon unreachable'));
    await submitted;
  });

  expect(result.current.draft).toBe('next thought');
  expect(result.current.sendError).toBe('daemon unreachable');
});

// The decide failure belongs to the session for exactly the reason the send
// failure does. While an approval is queued the Runs tab shows a waiting
// overseer row, so flipping there is the path the rail encourages — and the rail
// unmounts the chat on that flip. A transport-level failure reported into
// component state would land on an unmounted tree, leaving a confirm card that
// looks untouched with no explanation of why nothing happened.
test('a failed decision leaves its error on the session', async () => {
  const client = {
    baseUrl: `http://127.0.0.1:${PORT}`,
    startOverseer: () => Promise.resolve(overseerRecord()),
    getOverseer: () => Promise.resolve(overseerRecord()),
    confirmOverseerAction: () =>
      Promise.reject(new Error('daemon unreachable')),
  } as unknown as ApiClient;

  const { result } = renderHook(
    () => useOverseerSession(client, PORT, '/repo'),
    {
      wrapper,
    }
  );
  await act(async () => {
    await result.current.submit('what is going on?');
  });

  await act(async () => {
    await result.current.confirmAction('act-1', true);
  });

  // Never rejects — the outcome is readable here, the same contract `submit`
  // has, so no caller has to own a try/catch that outlives its own component.
  expect(result.current.decideError).toBe('daemon unreachable');
  // The lock still comes down: the action is back on the server's queue and
  // the card has to be clickable again.
  expect(result.current.decidingActionId).toBeNull();
});

// One decision at a time is a server-side invariant, not a cosmetic one: a
// second call would 404 against an action the first already claimed. The guard
// lives on the session because every card that could fire it is unmounted by
// an ordinary tab flip, which would reset a component-local one.
test('a second decision while one is in flight is a no-op', async () => {
  const calls: string[] = [];
  let settle: ((rec: OverseerRecord) => void) | undefined;
  const client = {
    baseUrl: `http://127.0.0.1:${PORT}`,
    startOverseer: () => Promise.resolve(overseerRecord()),
    getOverseer: () => Promise.resolve(overseerRecord()),
    confirmOverseerAction: (_id: string, actionId: string) => {
      calls.push(actionId);
      return new Promise<OverseerRecord>((resolve) => {
        settle = resolve;
      });
    },
  } as unknown as ApiClient;

  const { result } = renderHook(
    () => useOverseerSession(client, PORT, '/repo'),
    {
      wrapper,
    }
  );
  await act(async () => {
    await result.current.submit('what is going on?');
  });

  let first: Promise<void> | undefined;
  act(() => {
    first = result.current.confirmAction('act-1', true);
  });
  expect(result.current.decidingActionId).toBe('act-1');

  await act(async () => {
    await result.current.confirmAction('act-2', true);
  });
  expect(calls).toEqual(['act-1']);

  await act(async () => {
    settle?.(overseerRecord());
    await first;
  });
  expect(result.current.decidingActionId).toBeNull();
});

// reset() drops the conversation, so a failure banner from a decision on it
// has nothing to say about the empty composer that replaces it — the same rule
// `sendError` follows.
test('reset clears the last decide error', async () => {
  const client = {
    baseUrl: `http://127.0.0.1:${PORT}`,
    startOverseer: () => Promise.resolve(overseerRecord()),
    getOverseer: () => Promise.resolve(overseerRecord()),
    confirmOverseerAction: () =>
      Promise.reject(new Error('daemon unreachable')),
  } as unknown as ApiClient;

  const { result } = renderHook(
    () => useOverseerSession(client, PORT, '/repo'),
    {
      wrapper,
    }
  );
  await act(async () => {
    await result.current.submit('what is going on?');
  });
  await act(async () => {
    await result.current.confirmAction('act-1', true);
  });
  expect(result.current.decideError).toBe('daemon unreachable');

  act(() => {
    result.current.reset();
  });
  expect(result.current.decideError).toBeNull();
});
