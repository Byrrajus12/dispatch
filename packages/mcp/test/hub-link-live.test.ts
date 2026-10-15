import { hubDir, TaskStore, writeHubFile } from '@dispatch-foo/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { isDaemonHealthy, readDaemonFile } from '../src/daemon.js';
import type { HubHandle } from '../src/hub/server.js';
import { startHub } from '../src/hub/server.js';
import { createDispatchMcpServer } from '../src/index.js';

// A real dispatchd linked to the machine hub: a session on the hub waits on
// the project's own approval, then a person in the project and the session
// trade a message and its reply across the link, in one thread.

const APP_TOKEN = 'hub-link-app-token';
const CLIENT = 'test-client';

interface ToolCallResult {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: string; text?: string }[];
}

let fakeHome: string;
let root: string;
let daemon: Bun.Subprocess<'ignore', 'ignore', 'pipe'>;
let hub: HubHandle;
let base: string;
const saved = {
  DISPATCH_HOME: process.env.DISPATCH_HOME,
  DISPATCH_HUB: process.env.DISPATCH_HUB,
  DISPATCH_SESSION_ID: process.env.DISPATCH_SESSION_ID,
};

function owner(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${APP_TOKEN}`,
    },
  });
}

async function until<T>(
  what: string,
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

beforeAll(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-link-home-'));
  root = mkdtempSync(join(tmpdir(), 'dispatch-link-root-'));
  process.env.DISPATCH_HOME = fakeHome;
  process.env.DISPATCH_HUB = '1';
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
    ['commit', '--allow-empty', '-m', 'initial commit'],
  ])
    Bun.spawnSync(['git', ...args], { cwd: root });
  TaskStore.init(root);

  hub = await startHub({
    dir: hubDir(),
    token: 'hub-token',
    id: 'hub-id',
    handle: 'test',
  });
  writeHubFile({
    port: hub.port,
    pid: process.pid,
    id: 'hub-id',
    token: 'hub-token',
    version: 'test',
    startedAt: new Date().toISOString(),
  });

  const bin = join(
    dirname(
      createRequire(import.meta.url).resolve('@dispatch/server/package.json')
    ),
    'src',
    'bin.ts'
  );
  daemon = Bun.spawn(['bun', bin, '--root', root, '--port', '0'], {
    env: {
      ...process.env,
      DISPATCH_HOME: fakeHome,
      DISPATCH_APP_TOKEN: APP_TOKEN,
      DISPATCH_HUB: '1',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const info = await until('dispatchd', async () => {
    if (daemon.exitCode !== null)
      throw new Error(await new Response(daemon.stderr).text());
    const file = readDaemonFile(root);
    return file !== null && (await isDaemonHealthy(file.port)) ? file : null;
  });
  base = `http://127.0.0.1:${info.port}`;
}, 60_000);

afterAll(async () => {
  daemon.kill();
  await hub.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function roster(): Promise<
  { address: string; status: string; parent?: string }[]
> {
  const res = await owner('/api/agents/roster');
  return (
    (await res.json()) as {
      agents: { address: string; status: string; parent?: string }[];
    }
  ).agents;
}

describe('dispatchd linked to the machine hub', () => {
  it('holds a hub client to the project gate, then carries mail both ways', async () => {
    const server = createDispatchMcpServer(root, { unreadCacheMs: 0 });
    const client = new Client({ name: CLIENT, version: '1.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      process.env.DISPATCH_SESSION_ID = 'linked-session';
      return (await client.callTool({
        name,
        arguments: args,
      })) as ToolCallResult;
    };

    const me = (await call('whoami')).structuredContent!;
    expect(me.kind).toBe('session');
    const session = String(me.address);
    const parent = String(me.parent);

    // The project mirrors the hub's client as pending, behind its own gate.
    const pending = await until('the mirrored client', async () =>
      (await roster()).find((r) => r.address === parent)
    );
    expect(pending.status).toBe('pending');
    expect(
      (await roster()).find((r) => r.address === session)?.status ?? 'pending'
    ).toBe('pending');

    await owner(`/api/agents/${encodeURIComponent(parent)}/approve`, {
      method: 'POST',
    });
    await until('the session approved here', async () =>
      (await roster()).some(
        (r) => r.address === session && r.status === 'approved'
      )
    );

    // A person in the project writes to the session on the hub.
    const sent = await owner('/api/messages', {
      method: 'POST',
      body: JSON.stringify({
        to: [session],
        kind: 'message',
        body: 'can you check the migration?',
      }),
    });
    expect(sent.status).toBe(201);
    const question = (
      (await sent.json()) as { message: { id: string; thread: string } }
    ).message;

    const footer = await until('the unread line', async () => {
      const r = await call('task_list');
      const text = r.content.at(-1)?.text ?? '';
      return text.startsWith('[dispatch] 1 unread') ? text : null;
    });
    expect(footer).toContain('human:test');

    const inbox = await call('inbox_read');
    expect(JSON.stringify(inbox.structuredContent)).toContain(
      'can you check the migration?'
    );
    const reply = await call('msg_reply', {
      messageId: question.id,
      body: 'on it',
    });
    expect(reply.isError).toBeUndefined();

    // The reply crosses back and lands in the person's thread.
    const back = await until('the reply in the project', async () => {
      const res = await owner('/api/mailbox');
      const { items } = (await res.json()) as {
        items: { message: { body: string; thread: string; from: string } }[];
      };
      return items.find((i) => i.message.body === 'on it')?.message;
    });
    expect(back.thread).toBe(question.thread);
    expect(back.from).toBe(session);
  }, 90_000);
});
