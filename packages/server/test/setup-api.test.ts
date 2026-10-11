import { credentialsPath, TaskStore } from '@dispatch-foo/core';
import type { SetupReport } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setSetupCheckDepsForTest } from '../src/api/setup.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { useTestAuth } from './testAuth.js';

let root: string;
let home: string;
let handle: ServerHandle;
let baseUrl: string;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = home;
  root = mkdtempSync(join(tmpdir(), 'dispatch-setup-api-'));
  TaskStore.init(root);
  // A machine with git and a signed-in Claude, nothing else.
  setSetupCheckDepsForTest(() => ({
    path: '/bin',
    which: (b) => (['git', 'claude'].includes(b) ? `/bin/${b}` : null),
    run: (_cmd, args) => {
      const key = args.join(' ');
      if (key === 'config --get user.name')
        return Promise.resolve({ status: 0, stdout: 'Ada', stderr: '' });
      if (key === 'config --get user.email')
        return Promise.resolve({ status: 0, stdout: 'a@b.c', stderr: '' });
      if (key === 'auth status --json')
        return Promise.resolve({
          status: 0,
          stdout: '{"loggedIn":true}',
          stderr: '',
        });
      if (key.endsWith('--is-inside-work-tree'))
        return Promise.resolve({ status: 0, stdout: 'true', stderr: '' });
      return Promise.resolve({ status: 0, stdout: 'v1', stderr: '' });
    },
    env: {},
    savedAgentKeys: {},
  }));
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerExecutors: (o) =>
      o.registerExecutor(
        'claude',
        new FakeExecutor({ steps: [], finish: { state: 'finished' as const } })
      ),
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  setSetupCheckDepsForTest(null);
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('/api/setup', () => {
  it('reports git, project and agent for this root', async () => {
    const report = (await (
      await fetch(`${baseUrl}/api/setup`)
    ).json()) as SetupReport;
    expect(report.steps.map((s) => s.id)).toEqual(['git', 'project', 'agent']);
    expect(report.defaultProvider).toBe('claude');
  });

  it('saves and clears an agent API key in the machine-wide credentials', async () => {
    expect(
      (
        await post('/api/setup/agent-key', {
          provider: 'codex',
          apiKey: 'sk-1',
        })
      ).status
    ).toBe(200);
    const file = JSON.parse(readFileSync(credentialsPath(), 'utf8')) as {
      agents?: Record<string, string>;
    };
    expect(file.agents).toEqual({ OPENAI_API_KEY: 'sk-1' });
    await post('/api/setup/agent-key', { provider: 'codex', apiKey: null });
    expect(
      JSON.parse(readFileSync(credentialsPath(), 'utf8')).agents
    ).toBeUndefined();
  });

  it('rejects a provider that takes no API key', async () => {
    expect(
      (
        await post('/api/setup/agent-key', {
          provider: 'cursor-agent',
          apiKey: 'x',
        })
      ).status
    ).toBe(400);
    expect(
      (await post('/api/setup/agent-key', { provider: 'nope', apiKey: 'x' }))
        .status
    ).toBe(400);
  });

  it('refresh returns the executors it newly registered', async () => {
    const body = (await (await post('/api/setup/refresh', {})).json()) as {
      added: string[];
    };
    expect(Array.isArray(body.added)).toBe(true);
    expect(body.added).not.toContain('claude');
  });
});
