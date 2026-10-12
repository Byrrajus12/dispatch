import type { SetupReport } from '@dispatch-foo/core/browser';
import type { DraftRecord, RunMeta } from '@dispatch/client';
import { beforeEach, describe, expect, test } from 'bun:test';

import {
  deriveGuideStage,
  formTaskInput,
  guideProvider,
  type GuideRecord,
  readGuide,
  writeGuide,
} from './firstTaskGuide';

function draft(over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: 'd-1',
    prompt: 'add a dark mode toggle',
    plannerName: 'claude',
    state: 'ready',
    message: '',
    proposal: {
      tasks: [
        {
          title: 'Dark mode',
          description: '',
          acceptanceCriteria: [],
          priority: 'none',
        },
      ],
    } as unknown as DraftRecord['proposal'],
    questions: [],
    error: null,
    createdAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:00.000Z',
    ...over,
  };
}

function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Dark mode',
    executor: 'claude',
    state: 'running',
    branch: 'b',
    baseBranch: 'main',
    worktreePath: '/tmp/x',
    createdAt: '2026-10-11T00:01:00.000Z',
    updatedAt: '2026-10-11T00:01:00.000Z',
    ...over,
  } as RunMeta;
}

const TASKS = [{ meta: { id: 't-1' } }];
const active = (over: Partial<GuideRecord> = {}): GuideRecord => ({
  status: 'active',
  ...over,
});
const at = (
  record: GuideRecord,
  inputs: Partial<Parameters<typeof deriveGuideStage>[1]> = {}
) => deriveGuideStage(record, { drafts: [], tasks: [], runs: [], ...inputs });

describe('deriveGuideStage', () => {
  test('nothing linked yet is Describe it', () => {
    expect(at(active())).toEqual({ stage: 'describe' });
  });

  test('a drafting sentence waits on the planner', () => {
    const d = draft({ state: 'running', proposal: null });
    expect(at(active({ draftId: 'd-1' }), { drafts: [d] })).toEqual({
      stage: 'describe',
      draft: d,
      waiting: 'drafting',
    });
  });

  test('a failed draft stays on Describe it with its reason and planner', () => {
    const d = draft({
      state: 'failed',
      proposal: null,
      error: 'Not logged in',
    });
    expect(at(active({ draftId: 'd-1' }), { drafts: [d] })).toEqual({
      stage: 'describe',
      draft: d,
      failure: { error: 'Not logged in', providerId: 'claude' },
    });
  });

  test('a draft with only a question waits on you', () => {
    const d = draft({
      proposal: null,
      questions: [
        { question: 'Which page?' },
      ] as unknown as DraftRecord['questions'],
    });
    expect(at(active({ draftId: 'd-1' }), { drafts: [d] }).waiting).toBe(
      'question'
    );
  });

  test('a ready draft is Check the plan', () => {
    const d = draft();
    expect(at(active({ draftId: 'd-1' }), { drafts: [d] })).toEqual({
      stage: 'check',
      draft: d,
    });
  });

  test('a discarded draft goes back to Describe it', () => {
    expect(at(active({ draftId: 'd-1' }), { drafts: [] })).toEqual({
      stage: 'describe',
    });
  });

  test('a task with no run is Check the plan', () => {
    expect(at(active({ taskId: 't-1' }), { tasks: TASKS })).toEqual({
      stage: 'check',
      taskId: 't-1',
    });
  });

  test('a live run is Agent works', () => {
    const r = run();
    expect(at(active({ taskId: 't-1' }), { tasks: TASKS, runs: [r] })).toEqual({
      stage: 'works',
      taskId: 't-1',
      run: r,
    });
  });

  test('a failed run stays on Agent works with its reason and agent', () => {
    const r = run({
      state: 'failed',
      executor: 'codex',
      error: 'Not logged in',
    });
    expect(
      at(active({ taskId: 't-1' }), { tasks: TASKS, runs: [r] }).failure
    ).toEqual({
      error: 'Not logged in',
      providerId: 'codex',
    });
  });

  test('a finished run is Review until Looks good, then Land it', () => {
    const r = run({ state: 'finished' });
    expect(
      at(active({ taskId: 't-1' }), { tasks: TASKS, runs: [r] }).stage
    ).toBe('review');
    expect(
      at(active({ taskId: 't-1', approvedRunId: 'r-1' }), {
        tasks: TASKS,
        runs: [r],
      }).stage
    ).toBe('land');
  });

  test('Ask for changes follows the continuation and needs a fresh Looks good', () => {
    const first = run({ state: 'finished' });
    const next = run({
      id: 'r-2',
      resumedFrom: 'r-1',
      createdAt: '2026-10-11T00:05:00.000Z',
    });
    const record = active({ taskId: 't-1', approvedRunId: 'r-1' });
    expect(at(record, { tasks: TASKS, runs: [first, next] })).toMatchObject({
      stage: 'works',
      run: next,
    });
    const settled = { ...next, state: 'finished' } as RunMeta;
    expect(at(record, { tasks: TASKS, runs: [first, settled] }).stage).toBe(
      'review'
    );
  });

  test('a discarded or cancelled run goes back to Check the plan', () => {
    for (const r of [
      run({ state: 'finished', reviewedAt: 'x', reviewAction: 'discard' }),
      run({ state: 'cancelled' }),
    ]) {
      expect(
        at(active({ taskId: 't-1' }), { tasks: TASKS, runs: [r] }).stage
      ).toBe('check');
    }
  });

  test('a landed run is done; an open pull request is still Land it', () => {
    expect(
      at(active({ taskId: 't-1' }), {
        tasks: TASKS,
        runs: [
          run({ state: 'finished', reviewedAt: 'x', reviewAction: 'merge' }),
        ],
      }).stage
    ).toBe('done');
    expect(
      at(active({ taskId: 't-1' }), {
        tasks: TASKS,
        runs: [
          run({ state: 'finished', prUrl: 'https://github.com/a/b/pull/1' }),
        ],
      })
    ).toMatchObject({ stage: 'land', waitingOnPr: true });
  });

  test('review and verify runs on the task never move the guide', () => {
    const r = run({ kind: 'review' } as Partial<RunMeta>);
    expect(
      at(active({ taskId: 't-1' }), { tasks: TASKS, runs: [r] }).stage
    ).toBe('check');
  });

  test('a deleted task falls back to the draft, then to Describe it', () => {
    expect(at(active({ taskId: 't-1' }), { tasks: [] })).toEqual({
      stage: 'describe',
    });
  });

  test('a cancelled run that was later merged is done', () => {
    const r = run({
      state: 'cancelled',
      reviewedAt: 'x',
      reviewAction: 'merge',
    });
    expect(
      at(active({ taskId: 't-1' }), { tasks: TASKS, runs: [r] }).stage
    ).toBe('done');
  });

  test('a deleted task with its draft still present falls back to the draft', () => {
    const d = draft();
    expect(
      at(active({ taskId: 't-1', draftId: 'd-1' }), { tasks: [], drafts: [d] })
    ).toEqual({ stage: 'check', draft: d });
  });

  test('an interrupted-dirty run fails on Agent works', () => {
    const r = run({ state: 'interrupted-dirty', error: 'Stopped' });
    expect(
      at(active({ taskId: 't-1' }), { tasks: TASKS, runs: [r] })
    ).toMatchObject({ stage: 'works', failure: { error: 'Stopped' } });
  });

  test('an awaiting-approval run is still Agent works', () => {
    const r = run({ state: 'awaiting-approval' });
    expect(
      at(active({ taskId: 't-1' }), { tasks: TASKS, runs: [r] }).stage
    ).toBe('works');
  });

  test('a pull request run set aside to start over goes back to Check the plan', () => {
    const pr = run({
      state: 'finished',
      prUrl: 'https://github.com/a/b/pull/1',
    });
    const record = active({ taskId: 't-1', setAsideRunId: 'r-1' });
    expect(at(record, { tasks: TASKS, runs: [pr] })).toEqual({
      stage: 'check',
      taskId: 't-1',
    });
    // The next send is followed as usual.
    const next = run({ id: 'r-2', createdAt: '2026-10-11T00:05:00.000Z' });
    expect(at(record, { tasks: TASKS, runs: [pr, next] })).toMatchObject({
      stage: 'works',
      run: { id: 'r-2' },
    });
    // If the set-aside pull request merges anyway, the work did land.
    const merged = { ...pr, reviewedAt: 'x', reviewAction: 'pr' as const };
    expect(at(record, { tasks: TASKS, runs: [merged] }).stage).toBe('done');
  });

  test('verify runs on the task never move the guide', () => {
    const r = run({ kind: 'verify' });
    expect(
      at(active({ taskId: 't-1' }), { tasks: TASKS, runs: [r] }).stage
    ).toBe('check');
  });
});

describe('guideProvider', () => {
  const report = (plan: boolean, usingApiKey = false): SetupReport => ({
    steps: [],
    defaultProvider: 'codex',
    providers: [
      {
        id: 'codex',
        name: 'Codex',
        blurb: 'Uses your ChatGPT plan.',
        installed: true,
        works: true,
        auth: 'signed-in',
        usingApiKey,
        ready: true,
        capabilities: { execute: true, plan, oversee: plan },
      },
    ],
  });

  test('capabilities come from the report, so a provider that gains planning gets the planner', () => {
    expect(guideProvider(report(false), 'codex')?.plans).toBe(false);
    expect(guideProvider(report(true), 'codex')?.plans).toBe(true);
  });

  test('API-key mode is carried through', () => {
    expect(guideProvider(report(false, true), 'codex')?.usingApiKey).toBe(true);
  });

  test('without a report the core catalog answers', () => {
    expect(guideProvider(undefined, 'claude')).toEqual({
      id: 'claude',
      name: 'Claude Code',
      blurb: 'Uses your Claude Pro or Max plan.',
      plans: true,
      usingApiKey: false,
    });
  });

  test("an unknown agent is null, so the caller keeps today's path", () => {
    expect(guideProvider(undefined, 'fake')).toBeNull();
    expect(guideProvider(undefined, undefined)).toBeNull();
  });

  test('with nothing configured the report default is used', () => {
    expect(guideProvider(report(false), undefined)?.id).toBe('codex');
  });
});

describe('formTaskInput', () => {
  test('the first line titles the task and each done line is a criterion', () => {
    const input = formTaskInput(
      '  Add a dark mode toggle\non the settings page ',
      '- The toggle switches the theme\n\n* It remembers the choice ',
      'draft'
    );
    expect(input.title).toBe('Add a dark mode toggle');
    expect(input.status).toBe('draft');
    expect(input.description).toContain('on the settings page');
    expect(input.acceptanceCriteria).toBe(
      '- The toggle switches the theme\n- It remembers the choice'
    );
  });

  test('a long first line is cut to 80 characters', () => {
    expect(formTaskInput('x'.repeat(120), '', 'draft').title).toHaveLength(80);
  });
});

describe('guide storage', () => {
  beforeEach(() => window.localStorage.clear());

  test('round-trips per project', () => {
    writeGuide('/p/a', { status: 'active', taskId: 't-1' });
    expect(readGuide('/p/a')).toEqual({ status: 'active', taskId: 't-1' });
    expect(readGuide('/p/b')).toBeNull();
  });

  test('a set-aside run survives a reload', () => {
    writeGuide('/p/a', {
      status: 'active',
      taskId: 't-1',
      setAsideRunId: 'r-1',
    });
    expect(readGuide('/p/a')?.setAsideRunId).toBe('r-1');
  });

  test('a corrupt or unknown record reads as none', () => {
    window.localStorage.setItem('dispatch:first-task-guide:/p/a', '{nope');
    expect(readGuide('/p/a')).toBeNull();
    window.localStorage.setItem(
      'dispatch:first-task-guide:/p/a',
      '{"status":"bogus"}'
    );
    expect(readGuide('/p/a')).toBeNull();
  });
});
