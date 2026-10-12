import {
  type CreateInput,
  providerById,
  type SetupReport,
} from '@dispatch-foo/core/browser';
import type { DraftRecord, RunMeta } from '@dispatch/client';
import { taskDraftToCreateInput } from '@dispatch/client';

import { isTerminalRunState } from './runState';

// The first-task guide's progress, per project, in localStorage: it belongs to the
// person at this desk, so it never reaches the daemon or the repo.

export interface GuideRecord {
  status: 'active' | 'dismissed' | 'completed';
  /** The AI draft the guide follows until it becomes a task. */
  draftId?: string;
  /** The guide's task once it exists. */
  taskId?: string;
  /** The run the user said "Looks good" to; a newer run needs its own. */
  approvedRunId?: string;
  /** A pull request run the person started over from; the task is back at Check the plan. */
  setAsideRunId?: string;
}

const KEY_PREFIX = 'dispatch:first-task-guide:';
const STATUSES: ReadonlySet<string> = new Set([
  'active',
  'dismissed',
  'completed',
]);

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

export function readGuide(projectPath: string): GuideRecord | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + projectPath);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (parsed === null || typeof parsed !== 'object') return null;
    const status = parsed['status'];
    if (typeof status !== 'string' || !STATUSES.has(status)) return null;
    const record: GuideRecord = { status: status as GuideRecord['status'] };
    const draftId = text(parsed['draftId']);
    const taskId = text(parsed['taskId']);
    const approvedRunId = text(parsed['approvedRunId']);
    const setAsideRunId = text(parsed['setAsideRunId']);
    if (draftId !== undefined) record.draftId = draftId;
    if (taskId !== undefined) record.taskId = taskId;
    if (approvedRunId !== undefined) record.approvedRunId = approvedRunId;
    if (setAsideRunId !== undefined) record.setAsideRunId = setAsideRunId;
    return record;
  } catch {
    return null;
  }
}

export function writeGuide(projectPath: string, record: GuideRecord): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      KEY_PREFIX + projectPath,
      JSON.stringify(record)
    );
  } catch {
    // Blocked storage only means the guide may show again next launch.
  }
}

type GuideStage = 'describe' | 'check' | 'works' | 'review' | 'land' | 'done';

/** The five stages a person sees, in order; `done` is the completion state after them. */
export const GUIDE_STEPS: readonly {
  stage: Exclude<GuideStage, 'done'>;
  label: string;
}[] = [
  { stage: 'describe', label: 'Describe it' },
  { stage: 'check', label: 'Check the plan' },
  { stage: 'works', label: 'Agent works' },
  { stage: 'review', label: 'Review' },
  { stage: 'land', label: 'Land it' },
];

interface GuideFailure {
  error: string;
  providerId?: string;
}

export interface GuideView {
  stage: GuideStage;
  draft?: DraftRecord;
  taskId?: string;
  run?: RunMeta;
  failure?: GuideFailure;
  /** Stage 1 is waiting on the planner: still drafting, or holding a question. */
  waiting?: 'drafting' | 'question';
  /** Stage 5 went out as a pull request that has not merged yet. */
  waitingOnPr?: boolean;
}

interface GuideInputs {
  drafts: readonly DraftRecord[];
  tasks: readonly { meta: { id: string } }[];
  runs: readonly RunMeta[];
}

// The task's newest execute run; review and verify runs ride on the same task.
function latestExecuteRun(
  runs: readonly RunMeta[],
  taskId: string
): RunMeta | undefined {
  let latest: RunMeta | undefined;
  for (const run of runs) {
    if (run.taskId !== taskId || (run.kind ?? 'execute') !== 'execute')
      continue;
    if (latest === undefined || run.createdAt > latest.createdAt) latest = run;
  }
  return latest;
}

/** Where the guide's task stands, read fresh from the live drafts, tasks and runs. */
export function deriveGuideStage(
  record: GuideRecord,
  { drafts, tasks, runs }: GuideInputs
): GuideView {
  const { taskId } = record;
  if (taskId !== undefined && tasks.some((t) => t.meta.id === taskId)) {
    const run = latestExecuteRun(runs, taskId);
    if (run === undefined) return { stage: 'check', taskId };
    if (run.reviewedAt !== undefined && run.reviewAction !== 'discard') {
      return { stage: 'done', taskId, run };
    }
    if (
      run.state === 'cancelled' ||
      run.reviewAction === 'discard' ||
      run.id === record.setAsideRunId
    ) {
      return { stage: 'check', taskId };
    }
    if (!isTerminalRunState(run.state)) return { stage: 'works', taskId, run };
    if (run.state === 'failed' || run.state === 'interrupted-dirty') {
      return {
        stage: 'works',
        taskId,
        run,
        failure: {
          error: run.error ?? 'The agent stopped before it finished.',
          providerId: providerById(run.executor)?.id,
        },
      };
    }
    if (run.prUrl !== undefined) {
      return { stage: 'land', taskId, run, waitingOnPr: true };
    }
    if (record.approvedRunId === run.id) return { stage: 'land', taskId, run };
    return { stage: 'review', taskId, run };
  }
  const draft =
    record.draftId === undefined
      ? undefined
      : drafts.find((d) => d.id === record.draftId);
  if (draft === undefined) return { stage: 'describe' };
  if (draft.state === 'running') {
    return { stage: 'describe', draft, waiting: 'drafting' };
  }
  if (draft.state === 'failed') {
    return {
      stage: 'describe',
      draft,
      failure: {
        error: draft.error ?? 'Drafting the task failed.',
        providerId: providerById(draft.plannerName)?.id,
      },
    };
  }
  if ((draft.proposal?.tasks.length ?? 0) > 0) return { stage: 'check', draft };
  return { stage: 'describe', draft, waiting: 'question' };
}

export interface GuideProvider {
  id: string;
  name: string;
  /** The catalog's line on what it draws on, e.g. "Uses your Claude Pro or Max plan." */
  blurb: string;
  /** The catalog says it can draft a task from a sentence. */
  plans: boolean;
  usingApiKey: boolean;
}

/**
 * The agent the guide's task runs on: the configured one (else the report's default),
 * described by the setup report, else the core catalog. Null when neither knows it.
 */
export function guideProvider(
  report: SetupReport | undefined,
  configured: string | undefined
): GuideProvider | null {
  const id = configured ?? report?.defaultProvider ?? undefined;
  if (id === undefined) return null;
  const state = report?.providers.find((p) => p.id === id);
  if (state !== undefined) {
    return {
      id: state.id,
      name: state.name,
      blurb: state.blurb,
      plans: state.capabilities.plan,
      usingApiKey: state.usingApiKey,
    };
  }
  const spec = providerById(id);
  if (spec === undefined) return null;
  return {
    id: spec.id,
    name: spec.name,
    blurb: spec.blurb,
    plans: spec.capabilities.plan,
    usingApiKey: false,
  };
}

const TITLE_MAX = 80;

/** The two-field form as a task: the first line titles it, each "done" line is a criterion. */
export function formTaskInput(
  what: string,
  done: string,
  status: string
): CreateInput {
  const description = what.trim();
  const firstLine = description.split('\n')[0]?.trim() ?? '';
  const title =
    firstLine.length > TITLE_MAX
      ? `${firstLine.slice(0, TITLE_MAX - 1).trimEnd()}…`
      : firstLine;
  const acceptanceCriteria = done
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter((line) => line !== '');
  return {
    ...taskDraftToCreateInput({
      title,
      description,
      acceptanceCriteria,
      priority: 'none',
    }),
    status,
  };
}
