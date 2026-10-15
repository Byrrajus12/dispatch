import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { pruneIdleSessions } from '../../src/messaging/service.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { useTestAuth } from '../testAuth.js';

// MCP sessions: children of an approved client identity, approved at once,
// revoked with their parent, pruned when idle.

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function authHeaders(token: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initGitRepo('dispatch-sessions-');
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
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

function register(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/agents/register`, {
    method: 'POST',
    headers: authHeaders(handle.tokens.agentToken),
    body: JSON.stringify(body),
  });
}

async function approvedParent(): Promise<{ address: string; token: string }> {
  const parent = await json<{ address: string; token: string }>(
    await register({ name: 'claude-code.macbook', client: 'claude-code' })
  );
  await fetch(
    `${baseUrl}/api/agents/${encodeURIComponent(parent.address)}/approve`,
    { method: 'POST', headers: { 'content-type': 'application/json' } }
  );
  return parent;
}

function registerSession(
  parent: { address: string; token: string },
  over: Record<string, unknown> = {}
): Promise<Response> {
  return register({
    name: 'claude-code-7f3a2c',
    client: 'claude-code',
    parent: parent.address,
    parentToken: parent.token,
    meta: { kind: 'session', repo: 'dispatch', branch: 'main' },
    ...over,
  });
}

function sendAs(token: string): Promise<Response> {
  return fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ to: ['human:test'], kind: 'message', body: 'hi' }),
  });
}

interface RosterAgent {
  address: string;
  status: string;
  parent?: string;
  meta?: Record<string, string>;
  lastSeen?: string;
  online: boolean;
}

async function roster(): Promise<RosterAgent[]> {
  return (
    await json<{ agents: RosterAgent[] }>(
      await fetch(`${baseUrl}/api/agents/roster`, {
        headers: authHeaders(handle.tokens.agentToken),
      })
    )
  ).agents;
}

async function openRegistrationCards(): Promise<number> {
  type Card = { data?: { type?: string } };
  const open = await json<{ items: Card[] }>(
    await fetch(`${baseUrl}/api/decisions/open`)
  );
  return open.items.filter((m) => m.data?.type === 'agent-registration').length;
}

describe('session registration', () => {
  it('approves a session of an approved parent at once, with no gate', async () => {
    const parent = await approvedParent();
    const res = await registerSession(parent);
    expect(res.status).toBe(201);
    const session = await json<{
      address: string;
      token: string;
      status: string;
    }>(res);
    expect(session.address).toBe('agent:test/claude-code-7f3a2c');
    expect(session.status).toBe('approved');
    expect(await openRegistrationCards()).toBe(0);
    expect((await sendAs(session.token)).status).toBe(201);

    const row = (await roster()).find((a) => a.address === session.address);
    expect(row?.parent).toBe(parent.address);
    expect(row?.meta).toEqual({
      kind: 'session',
      repo: 'dispatch',
      branch: 'main',
    });
    expect(row?.online).toBe(true);
  });

  it('refuses a wrong parent token', async () => {
    const parent = await approvedParent();
    const res = await registerSession({ ...parent, token: 'f'.repeat(64) });
    expect(res.status).toBe(403);
  });

  it('refuses a parent that is still pending', async () => {
    const pending = await json<{ address: string; token: string }>(
      await register({ name: 'codex.macbook', client: 'codex' })
    );
    const res = await registerSession(pending);
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toContain(
      'not approved'
    );
  });

  it('refuses a session as a parent', async () => {
    const parent = await approvedParent();
    const session = await json<{ address: string; token: string }>(
      await registerSession(parent)
    );
    const res = await registerSession(session, { name: 'grandchild' });
    expect(res.status).toBe(400);
  });

  it('re-registers the same session with a new token, retiring the old one', async () => {
    const parent = await approvedParent();
    const first = await json<{ token: string }>(await registerSession(parent));
    const again = await registerSession(parent);
    expect(again.status).toBe(201);
    const second = await json<{ token: string }>(again);
    expect(second.token).not.toBe(first.token);
    expect((await sendAs(first.token)).status).toBe(401);
    expect((await sendAs(second.token)).status).toBe(201);
  });

  it('keeps only known meta keys, capped and printable', async () => {
    const parent = await approvedParent();
    const session = await json<{ address: string }>(
      await registerSession(parent, {
        meta: {
          label: `a\u0007b${'x'.repeat(300)}`,
          repo: 'dispatch',
          secret: 'nope',
          pid: 42,
        },
      })
    );
    const row = (await roster()).find((a) => a.address === session.address);
    expect(Object.keys(row?.meta ?? {}).sort()).toEqual(['label', 'repo']);
    expect(row?.meta?.label).toBe(`ab${'x'.repeat(198)}`);
  });

  it('holds a session name to the same rules as any agent name', async () => {
    const parent = await approvedParent();
    expect((await registerSession(parent, { name: 'a2a.sneaky' })).status).toBe(
      400
    );
    expect((await registerSession(parent, { name: '---' })).status).toBe(400);
  });

  it('keeps a revoked session revoked', async () => {
    const parent = await approvedParent();
    const session = await json<{ address: string }>(
      await registerSession(parent)
    );
    await fetch(
      `${baseUrl}/api/agents/${encodeURIComponent(session.address)}/revoke`,
      { method: 'POST', headers: { 'content-type': 'application/json' } }
    );
    expect((await registerSession(parent)).status).toBe(409);
  });

  it('mutes a muted parent’s sessions', async () => {
    const parent = await approvedParent();
    await fetch(
      `${baseUrl}/api/agents/${encodeURIComponent(parent.address)}/mute`,
      { method: 'POST', headers: { 'content-type': 'application/json' } }
    );
    const session = await json<{ address: string }>(
      await registerSession(parent)
    );
    expect(handle.messaging.store.getAgent(session.address)?.muted).toBe(true);
  });

  it('mutes and unmutes existing sessions with their parent', async () => {
    const parent = await approvedParent();
    const session = await json<{ address: string }>(
      await registerSession(parent)
    );
    const toggle = (verb: string) =>
      fetch(
        `${baseUrl}/api/agents/${encodeURIComponent(parent.address)}/${verb}`,
        { method: 'POST', headers: { 'content-type': 'application/json' } }
      );
    const muted = () => handle.messaging.store.getAgent(session.address)?.muted;
    await toggle('mute');
    expect(muted()).toBe(true);
    await toggle('unmute');
    expect(muted()).toBe(false);
  });

  it('refuses a parent that may not use messaging itself', async () => {
    const parent = await approvedParent();
    const store = handle.messaging.store;
    const row = store.getAgent(parent.address)!;
    // An A2A client's token works only on the A2A listener.
    const client = { ...row, address: 'agent:test/a2a.partner' };
    store.putAgent({ ...row, tokenHash: 'retired' });
    store.putAgent(client);
    const asClient = await registerSession({
      address: client.address,
      token: parent.token,
    });
    expect(asClient.status).toBe(403);
    // A teammate's replicated agent is approved only on its own machine.
    store.putAgent({ ...client, tokenHash: `remote:${row.tokenHash}` });
    expect(
      (await registerSession({ address: client.address, token: parent.token }))
        .status
    ).toBe(403);
  });
});

describe('session lifecycle', () => {
  it('keeps sessions cut when a revoked parent name registers again', async () => {
    const parent = await approvedParent();
    const session = await json<{ token: string }>(
      await registerSession(parent)
    );
    await fetch(
      `${baseUrl}/api/agents/${encodeURIComponent(parent.address)}/revoke`,
      { method: 'POST', headers: { 'content-type': 'application/json' } }
    );
    await approvedParent();
    expect((await sendAs(session.token)).status).toBe(401);
  });

  it('keeps a session’s own mute when it registers again', async () => {
    const parent = await approvedParent();
    const session = await json<{ address: string }>(
      await registerSession(parent)
    );
    await fetch(
      `${baseUrl}/api/agents/${encodeURIComponent(session.address)}/mute`,
      { method: 'POST', headers: { 'content-type': 'application/json' } }
    );
    await registerSession(parent);
    expect(handle.messaging.store.getAgent(session.address)?.muted).toBe(true);
  });

  it('stops a session authenticating once its parent is revoked', async () => {
    const parent = await approvedParent();
    const session = await json<{ token: string }>(
      await registerSession(parent)
    );
    await fetch(
      `${baseUrl}/api/agents/${encodeURIComponent(parent.address)}/revoke`,
      { method: 'POST', headers: { 'content-type': 'application/json' } }
    );
    const res = await sendAs(session.token);
    expect(res.status).toBe(401);
    expect((await json<{ code: string }>(res)).code).toBe('auth_agent_revoked');
  });

  it('lets a session set its own label', async () => {
    const parent = await approvedParent();
    const session = await json<{ address: string; token: string }>(
      await registerSession(parent)
    );
    const res = await fetch(`${baseUrl}/api/agents/me/meta`, {
      method: 'POST',
      headers: authHeaders(session.token),
      body: JSON.stringify({ label: 'auth refactor' }),
    });
    expect(res.status).toBe(200);
    const row = (await roster()).find((a) => a.address === session.address);
    expect(row?.meta?.label).toBe('auth refactor');
    expect(row?.meta?.repo).toBe('dispatch');
  });

  it('refuses a label from a non-agent caller', async () => {
    const res = await fetch(`${baseUrl}/api/agents/me/meta`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'owner' }),
    });
    expect(res.status).toBe(403);
  });

  it('prunes only sessions idle past the cutoff', async () => {
    const parent = await approvedParent();
    const session = await json<{ address: string }>(
      await registerSession(parent)
    );
    const store = handle.messaging.store;
    const dayMs = 24 * 60 * 60 * 1000;
    expect(pruneIdleSessions(store, Date.now(), dayMs)).toBe(0);
    expect(pruneIdleSessions(store, Date.now() + 2 * dayMs, dayMs)).toBe(1);
    expect(store.getAgent(session.address)).toBeNull();
    expect(store.getAgent(parent.address)).not.toBeNull();
  });
});
