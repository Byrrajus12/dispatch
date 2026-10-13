import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// The desktop's Git page, Impact, Notes clustering and branch actions were the only
// callers of these routes; with them gone (#132) the daemon no longer serves them.
// Requests carry the app token, so a 404 means the route is gone, not refused.

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-pruned-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initRepo();
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const GONE: [string, string][] = [
  ['GET', '/api/git/status'],
  ['GET', '/api/git/log'],
  ['GET', '/api/git/branches'],
  ['GET', '/api/git/diff'],
  ['GET', '/api/git/stash'],
  ['POST', '/api/git/stage'],
  ['POST', '/api/git/commit'],
  ['POST', '/api/git/commit-message'],
  ['POST', '/api/git/pull'],
  ['POST', '/api/git/push'],
  ['DELETE', '/api/git/branch/feature'],
  ['POST', '/api/git/stash/drop'],
  ['POST', '/api/branches/free-disk'],
  ['DELETE', '/api/branches/dispatch/r-1'],
  ['POST', '/api/inbox/cluster'],
  ['GET', '/api/inbox/clusters'],
  ['GET', '/api/inbox/triage'],
  ['PATCH', '/api/inbox/i-1'],
];

function send(method: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: '{}' }),
  });
}

describe('routes only the pruned desktop views used are gone', () => {
  for (const [method, path] of GONE) {
    // The router's own miss, so a handler's "no such item" 404 can't pass for a
    // removed route.
    it(`${method} ${path} answers like an unknown route`, async () => {
      const res = await send(method, path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: `not found: ${path}` });
    });
  }

  it('GET /api/runs/claims is now just a lookup of a run named "claims"', async () => {
    const res = await send('GET', '/api/runs/claims');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'run not found: claims' });
  });

  it('the routes that stay still answer', async () => {
    expect((await fetch(`${baseUrl}/api/branches`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/inbox`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/runs`)).status).toBe(200);
  });
});
