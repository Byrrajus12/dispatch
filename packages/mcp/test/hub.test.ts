import { hubDir, readHubFile, writeHubFile } from '@dispatch-foo/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HubHandle } from '../src/hub/server.js';
import { startHub } from '../src/hub/server.js';
import { createDispatchMcpServer } from '../src/index.js';

// The machine hub: approves this user's clients at once, homes their
// sessions whatever repo they are in, and carries mail between them.

const HUB_TOKEN = 'hub-token';
const HUB_ID = 'hub-id';

let home: string;
let hub: HubHandle;
let base: string;
const saved = {
  DISPATCH_HOME: process.env.DISPATCH_HOME,
  DISPATCH_HUB: process.env.DISPATCH_HUB,
  DISPATCH_SESSION_ID: process.env.DISPATCH_SESSION_ID,
  DISPATCH_AGENT_NAME: process.env.DISPATCH_AGENT_NAME,
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-hub-home-'));
  process.env.DISPATCH_HOME = home;
  process.env.DISPATCH_HUB = '1';
  delete process.env.DISPATCH_AGENT_NAME;
  hub = await startHub({
    dir: home,
    token: HUB_TOKEN,
    id: HUB_ID,
    handle: 'wyat',
  });
  base = `http://127.0.0.1:${hub.port}`;
});

afterEach(async () => {
  await hub.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function post(path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function register(
  body: Record<string, unknown>
): Promise<{ address: string; token: string; status: string }> {
  const res = await post('/api/agents/register', HUB_TOKEN, body);
  expect(res.status).toBe(201);
  return (await res.json()) as {
    address: string;
    token: string;
    status: string;
  };
}

describe('hub registration and mail', () => {
  it('approves a client at once and its sessions under it', async () => {
    const client = await register({ name: 'codex.mac', client: 'codex' });
    expect(client).toMatchObject({
      address: 'agent:wyat/codex.mac',
      status: 'approved',
    });
    const a = await register({
      name: 'codex-aaaaaa',
      client: 'codex',
      parent: client.address,
      parentToken: client.token,
      meta: { repo: 'api', secret: 'x' },
    });
    const b = await register({
      name: 'codex-bbbbbb',
      client: 'codex',
      parent: client.address,
      parentToken: client.token,
      meta: { repo: 'web' },
    });

    const sent = await post('/api/messages', a.token, {
      to: [b.address],
      kind: 'message',
      body: 'what does /v2/users return?',
    });
    expect(sent.status).toBe(201);
    const mailbox = (await (
      await fetch(`${base}/api/mailbox?state=held,notified,pushed`, {
        headers: { authorization: `Bearer ${b.token}` },
      })
    ).json()) as { items: { message: { body: string; from: string } }[] };
    expect(mailbox.items.map((i) => i.message)).toMatchObject([
      { body: 'what does /v2/users return?', from: a.address },
    ]);

    const roster = (await (
      await fetch(`${base}/api/agents/roster`, {
        headers: { authorization: `Bearer ${HUB_TOKEN}` },
      })
    ).json()) as {
      agents: { address: string; meta?: object; online: boolean }[];
    };
    expect(roster.agents.find((r) => r.address === a.address)).toMatchObject({
      meta: { repo: 'api' },
      online: true,
    });
  });

  it('refuses a forged parent token, the hub token as a sender, and run mail', async () => {
    const client = await register({ name: 'codex.mac', client: 'codex' });
    expect(
      (
        await post('/api/agents/register', HUB_TOKEN, {
          name: 'codex-cccccc',
          client: 'codex',
          parent: client.address,
          parentToken: 'nope',
        })
      ).status
    ).toBe(403);
    expect(
      (
        await post('/api/messages', HUB_TOKEN, {
          to: [client.address],
          kind: 'message',
          body: 'hi',
        })
      ).status
    ).toBe(403);
    const toRun = await post('/api/messages', client.token, {
      to: ['run:r-abc123'],
      kind: 'message',
      body: 'hi',
    });
    expect(toRun.status).toBe(400);
    const toNobody = await post('/api/messages', client.token, {
      to: ['agent:wyat/ghost'],
      kind: 'message',
      body: 'hi',
    });
    expect(toNobody.status).toBe(400);
  });

  it('re-keys a held client name only when asked, retiring its sessions', async () => {
    const client = await register({ name: 'codex.mac', client: 'codex' });
    const session = await register({
      name: 'codex-dddddd',
      client: 'codex',
      parent: client.address,
      parentToken: client.token,
    });
    const again = await post('/api/agents/register', HUB_TOKEN, {
      name: 'codex.mac',
      client: 'codex',
    });
    expect(again.status).toBe(409);
    const rekeyed = await register({
      name: 'codex.mac',
      client: 'codex',
      rekey: true,
    });
    expect(rekeyed.token).not.toBe(client.token);
    const old = await fetch(`${base}/api/mailbox`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(old.status).toBe(401);
  });

  it('lists a repo channel of the sessions working in that repo', async () => {
    const client = await register({
      name: 'claude.mac',
      client: 'claude-code',
    });
    const a = await register({
      name: 'claude-code-aaaaaa',
      client: 'claude-code',
      parent: client.address,
      parentToken: client.token,
      meta: { repo: 'dispatch' },
    });
    const res = await fetch(`${base}/api/channels`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    const { channels } = (await res.json()) as {
      channels: { name: string; auto: boolean; members: string[] }[];
    };
    expect(channels).toContainEqual({
      name: 'repo/dispatch',
      auto: true,
      members: [a.address],
    });
  });
});

describe('MCP sessions over the hub', () => {
  it('lets sessions in two repos with no dispatchd message each other', async () => {
    writeHubFile({
      port: hub.port,
      pid: process.pid,
      id: HUB_ID,
      token: HUB_TOKEN,
      version: 'test',
      startedAt: new Date().toISOString(),
    });
    expect(hubDir()).toBe(join(home, '.dispatch', 'hub'));
    const api = mkdtempSync(join(tmpdir(), 'dispatch-hub-api-'));
    const web = mkdtempSync(join(tmpdir(), 'dispatch-hub-web-'));
    try {
      const session = async (root: string, id: string) => {
        const server = createDispatchMcpServer(root, { unreadCacheMs: 0 });
        const client = new Client({ name: 'claude-code', version: '2.1' });
        const [x, y] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(x), server.connect(y)]);
        return async (name: string, args: Record<string, unknown> = {}) => {
          process.env.DISPATCH_SESSION_ID = id;
          return (await client.callTool({ name, arguments: args })) as {
            structuredContent?: Record<string, unknown>;
            content: { text?: string }[];
            isError?: boolean;
          };
        };
      };
      const inApi = await session(api, 'api-session');
      const inWeb = await session(web, 'web-session');

      const a = (await inApi('whoami')).structuredContent!;
      const b = (await inWeb('whoami')).structuredContent!;
      expect(a.kind).toBe('session');
      expect(b.kind).toBe('session');
      expect(a.address).not.toBe(b.address);

      const sent = await inApi('msg_send', {
        to: [b.address],
        kind: 'message',
        body: 'is the users endpoint paginated?',
      });
      expect(sent.isError).toBeUndefined();
      const next = await inWeb('agent_list');
      expect(next.content.at(-1)?.text).toBe(
        `[dispatch] 1 unread (from ${String(a.address)}). Call inbox_read.`
      );
    } finally {
      rmSync(api, { recursive: true, force: true });
      rmSync(web, { recursive: true, force: true });
    }
  });
});

describe('hub autostart', () => {
  it('starts one detached hub on first use, which a second start leaves alone', async () => {
    const own = mkdtempSync(join(tmpdir(), 'dispatch-hub-auto-'));
    const root = mkdtempSync(join(tmpdir(), 'dispatch-hub-auto-root-'));
    process.env.DISPATCH_HOME = own;
    process.env.DISPATCH_SESSION_ID = 'auto-session';
    let pid: number | undefined;
    try {
      const server = createDispatchMcpServer(root);
      const client = new Client({ name: 'codex', version: '1' });
      const [x, y] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(x), server.connect(y)]);
      const who = (await client.callTool({
        name: 'whoami',
        arguments: {},
      })) as {
        structuredContent?: { kind: string; address: string };
      };
      expect(who.structuredContent?.kind).toBe('session');

      const info = readHubFile();
      expect(info).not.toBeNull();
      pid = info!.pid;
      expect(pid).not.toBe(process.pid);

      // A second hub sees the live one through the lock and the file, and exits.
      const second = Bun.spawn(
        ['bun', join(import.meta.dirname, '../src/bin.ts'), 'hub'],
        {
          env: { ...process.env },
          stdout: 'ignore',
          stderr: 'ignore',
        }
      );
      expect(await second.exited).toBe(0);
      expect(readHubFile()?.pid).toBe(pid);
    } finally {
      if (pid !== undefined) {
        process.kill(pid, 'SIGTERM');
        for (let i = 0; i < 50; i++) {
          try {
            process.kill(pid, 0);
            await Bun.sleep(50);
          } catch {
            break;
          }
        }
      }
      rmSync(own, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('hub identity', () => {
  it('sends no token to a port that cannot prove it is the hub', async () => {
    let sawBearer = false;
    const impostor = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        if (req.headers.get('authorization') !== null) sawBearer = true;
        return Response.json({ ok: true, hub: true, id: 'someone-else' });
      },
    });
    const root = mkdtempSync(join(tmpdir(), 'dispatch-hub-impostor-'));
    try {
      writeHubFile({
        port: impostor.port ?? 0,
        pid: process.pid,
        id: HUB_ID,
        token: HUB_TOKEN,
        version: 'test',
        startedAt: new Date().toISOString(),
      });
      process.env.DISPATCH_SESSION_ID = 'impostor-session';
      const server = createDispatchMcpServer(root);
      const client = new Client({ name: 'codex', version: '1' });
      const [x, y] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(x), server.connect(y)]);
      // The real hub file names a live pid, so no second hub starts either.
      const result = (await client.callTool({
        name: 'whoami',
        arguments: {},
      })) as { isError?: boolean };
      expect(result.isError).toBe(true);
      expect(sawBearer).toBe(false);
    } finally {
      void impostor.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
