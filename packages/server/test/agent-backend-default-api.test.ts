import { DEFAULT_MODELS, TaskStore, updateConfig } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import type {
  Planner,
  PlannerMode,
  PlannerTurn,
} from '../src/orchestrator/planner.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// Records the model and mode of every turn; answers with a one-task proposal.
class RecordingPlanner implements Planner {
  readonly turns: { model?: string; mode?: PlannerMode }[] = [];

  start(
    _prompt: string,
    model?: string,
    mode?: PlannerMode
  ): Promise<PlannerTurn> {
    this.turns.push({ model, mode });
    return Promise.resolve({
      reply: 'ok',
      proposal: {
        tasks: [
          {
            title: 'Do it',
            description: '',
            acceptanceCriteria: ['done'],
            blockedByIndices: [],
            priority: 'medium',
          },
        ],
      },
      questions: [],
      sessionId: '1',
    });
  }

  sendMessage(
    _sessionId: string | undefined,
    message: string,
    model?: string,
    mode?: PlannerMode
  ): Promise<PlannerTurn> {
    return this.start(message, model, mode);
  }
}

let fakeHome: string;
let root: string;
let taskId: string;
let handle: ServerHandle | undefined;
let baseUrl: string;
let claude: RecordingPlanner;
let codex: RecordingPlanner;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-agent-default-'));
  runGitSync(root, ['init', '-b', 'main']);
  runGitSync(root, ['config', 'user.email', 'test@example.com']);
  runGitSync(root, ['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'README.md'), '# test repo\n');
  runGitSync(root, ['add', '-A']);
  runGitSync(root, ['commit', '-m', 'initial commit']);
  taskId = TaskStore.init(root).create({ title: 'Polish the footer' }).meta.id;
  claude = new RecordingPlanner();
  codex = new RecordingPlanner();
});

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function boot(): Promise<void> {
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerPlanners: (planManager) => {
      planManager.registerPlanner('claude', claude);
      planManager.registerPlanner('codex', codex);
    },
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor(
        'claude',
        new FakeExecutor({ finish: { state: 'finished' } })
      );
      orchestrator.registerExecutor(
        'codex',
        new FakeExecutor({ finish: { state: 'finished' } })
      );
    },
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('which planner a request with none named gets', () => {
  it('drafts on Claude, on the draft model, when the project runs on Claude', async () => {
    await boot();
    const draft = await json(
      await post('/api/tasks/draft', { prompt: 'rename it' })
    );
    expect(draft.plannerName).toBe('claude');
    expect(claude.turns).toEqual([
      { model: DEFAULT_MODELS.draft, mode: 'draft' },
    ]);
    expect(codex.turns).toEqual([]);
  });

  it('drafts, plans and adds detail on Codex when Codex is the default agent', async () => {
    updateConfig(root, {
      executor: 'codex',
      executors: { codex: { models: { plan: 'gpt-5.5' } } },
    });
    await boot();

    const draft = await json(
      await post('/api/tasks/draft', { prompt: 'rename it' })
    );
    expect(draft.plannerName).toBe('codex');

    const { planId } = await json(
      await post('/api/plan', { prompt: 'plan it' })
    );
    expect(
      (await json(await fetch(`${baseUrl}/api/plan/${planId}`))).plannerName
    ).toBe('codex');

    const enrich = await json(await post(`/api/tasks/${taskId}/enrich`, {}));
    expect(
      (await json(await fetch(`${baseUrl}/api/plan/${enrich.planId}`)))
        .plannerName
    ).toBe('codex');

    expect(codex.turns).toEqual([
      { model: 'gpt-5.5', mode: 'draft' },
      { model: 'gpt-5.5', mode: 'plan' },
      { model: 'gpt-5.5', mode: 'plan' },
    ]);
    expect(claude.turns).toEqual([]);
  });

  it('a Claude model pick never reaches Codex', async () => {
    updateConfig(root, { executor: 'codex' });
    await boot();
    await post('/api/plan', { prompt: 'plan it', model: 'claude-opus-5-5' });
    expect(codex.turns).toEqual([{ model: undefined, mode: 'plan' }]);
  });

  it('an explicitly named planner still wins', async () => {
    updateConfig(root, { executor: 'codex' });
    await boot();
    const draft = await json(
      await post('/api/tasks/draft', { prompt: 'rename it', planner: 'claude' })
    );
    expect(draft.plannerName).toBe('claude');
  });
});
