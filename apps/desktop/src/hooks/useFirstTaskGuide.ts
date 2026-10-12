import type { DraftRecord, RunMeta } from '@dispatch/client';
import { useCallback, useEffect, useMemo, useState } from 'react';

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
      update({ draftId, taskId: undefined, approvedRunId: undefined }),
    linkTask: (taskId) => update({ taskId, approvedRunId: undefined }),
    approve: (runId) => update({ approvedRunId: runId }),
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
