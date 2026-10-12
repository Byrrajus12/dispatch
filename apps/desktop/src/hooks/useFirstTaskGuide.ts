import type { DraftRecord, RunMeta } from '@dispatch/client';
import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  deriveGuideStage,
  type GuideRecord,
  type GuideView,
  readGuide,
  writeGuide,
} from '../lib/firstTaskGuide';

interface UseFirstTaskGuideInput {
  projectPath: string | null;
  /** Setup is finished and no gate screen is up; the guide never starts before that. */
  enabled: boolean;
  /** The project has loaded and has no tasks at all, archived included. */
  projectEmpty: boolean;
  drafts: readonly DraftRecord[];
  tasks: readonly { meta: { id: string } }[];
  runs: readonly RunMeta[];
}

export interface FirstTaskGuideState {
  /** What the card shows, or null when the guide is hidden. */
  view: GuideView | null;
  /** The guide is following a task right now, so new drafts and tasks link to it. */
  active: boolean;
  draftId: string | undefined;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /** The last guided Send to agent that failed, shown on the card until the next send. */
  sendError: string | null;
  setSendError: (error: string | null) => void;
  linkDraft: (draftId: string) => void;
  linkTask: (taskId: string) => void;
  approve: (runId: string) => void;
  /** Sets a pull request run aside so the task goes back to Check the plan. */
  startOver: (runId: string) => void;
  dismiss: () => void;
  restart: () => void;
  closeCompletion: () => void;
}

const readFor = (path: string | null) =>
  path === null ? null : readGuide(path);

/** The active project's first-task guide: its stored progress plus the stage live data puts it at. */
export function useFirstTaskGuide({
  projectPath,
  enabled,
  projectEmpty,
  drafts,
  tasks,
  runs,
}: UseFirstTaskGuideInput): FirstTaskGuideState {
  const [path, setPath] = useState(projectPath);
  const [record, setRecord] = useState<GuideRecord | null>(() =>
    readFor(projectPath)
  );
  const [celebration, setCelebration] = useState<GuideView | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  if (path !== projectPath) {
    // A project switch reads that project's record; nothing carries over.
    setPath(projectPath);
    setRecord(readFor(projectPath));
    setCelebration(null);
    setCollapsed(false);
    setSendError(null);
  }

  const save = useCallback(
    (next: GuideRecord) => {
      if (projectPath === null) return;
      writeGuide(projectPath, next);
      setRecord(next);
    },
    [projectPath]
  );

  // A fresh, empty project starts the guide once; a project with tasks never does on its own.
  useEffect(() => {
    if (enabled && projectPath !== null && record === null && projectEmpty) {
      save({ status: 'active' });
    }
  }, [enabled, projectPath, record, projectEmpty, save]);

  const derived = useMemo(
    () =>
      enabled && record?.status === 'active'
        ? deriveGuideStage(record, { drafts, tasks, runs })
        : null,
    [enabled, record, drafts, tasks, runs]
  );

  // Landing finishes the guide for good; the completion state shows until closed.
  useEffect(() => {
    if (derived?.stage !== 'done' || record === null) return;
    save({ ...record, status: 'completed' });
    setCelebration(derived);
  }, [derived, record, save]);

  const update = (patch: Partial<GuideRecord>) => {
    if (record?.status === 'active') save({ ...record, ...patch });
  };

  return {
    view: celebration ?? derived,
    active: derived !== null,
    draftId: record?.draftId,
    collapsed,
    setCollapsed,
    sendError,
    setSendError,
    linkDraft: (draftId) =>
      update({
        draftId,
        taskId: undefined,
        approvedRunId: undefined,
        setAsideRunId: undefined,
      }),
    linkTask: (taskId) =>
      update({ taskId, approvedRunId: undefined, setAsideRunId: undefined }),
    approve: (runId) => update({ approvedRunId: runId }),
    startOver: (runId) =>
      update({ setAsideRunId: runId, approvedRunId: undefined }),
    dismiss: () => {
      save({ status: 'dismissed' });
      setCelebration(null);
    },
    restart: () => {
      save({ status: 'active' });
      setCelebration(null);
      setCollapsed(false);
      setSendError(null);
    },
    closeCompletion: () => setCelebration(null),
  };
}

interface TaskListState {
  /** The list has loaded for the current connection. */
  ready: boolean;
  /** Tasks in it, archived included. */
  count: number;
  /** The task list's query key; when it last arrived is read from the query cache. */
  queryKey: QueryKey;
}

/**
 * Whether `projectPath` is a fresh, empty project: its task list has loaded and holds nothing.
 * After a switch from another project, only a list that arrived since the switch counts.
 */
export function useFreshEmptyProject(
  projectPath: string | null,
  { ready, count, queryKey }: TaskListState
): boolean {
  const queryClient = useQueryClient();
  const fetchedAt = () =>
    queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0;
  // The last project seen and the fetch time on screen when it arrived; -1 trusts any list,
  // as nothing came before it. A pass through no project still counts as a switch.
  const [seen, setSeen] = useState({ path: projectPath, fetchedAt: -1 });
  let current = seen;
  if (projectPath !== null && seen.path !== projectPath) {
    current = {
      path: projectPath,
      fetchedAt: seen.path === null ? -1 : fetchedAt(),
    };
    setSeen(current);
  }
  const captured = current.fetchedAt;
  // A boolean snapshot, so a refetch re-renders the caller only when the answer flips.
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient]
  );
  const arrivedSince = useSyncExternalStore(
    subscribe,
    () => captured === -1 || fetchedAt() !== captured
  );
  return projectPath !== null && ready && arrivedSince && count === 0;
}
