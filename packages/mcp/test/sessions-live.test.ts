import { TaskStore } from '@dispatch-foo/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { isDaemonHealthy, readDaemonFile } from '../src/daemon.js';
import { agentName, agentTokenFilePath } from '../src/identity.js';
import { createDispatchMcpServer } from '../src/index.js';

// Two MCP sessions of one client in one project, against a real dispatchd:
// each gets its own address, sees the other in agent_list, and learns of the
// other's message from the unread line on its next tool call.

const APP_TOKEN = 'live-sessions-app-token';
const CLIENT = 'test-client';

interface ToolCallResult {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: string; text?: string }[];
  _meta?: Record<string, unknown>;
}

function resolveDaemonBin(): string {
  const pkgJsonPath = createRequire(import.meta.url).resolve(
    '@dispatch/server/package.json'
  );
  return join(dirname(pkgJsonPath), 'src', 'bin.ts');
}

let fakeHome: string;
let root: string;
let child: Bun.Subprocess<'ignore', 'ignore', 'pipe'>;
let baseUrl: string;
const saved = {
  DISPATCH_HOME: process.env.DISPATCH_HOME,
  DISPATCH_SESSION_ID: process.env.DISPATCH_SESSION_ID,
  DISPATCH_SESSIONS: process.env.DISPATCH_SESSIONS,
  DISPATCH_AGENT_NAME: process.env.DISPATCH_AGENT_NAME,
};

beforeAll(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-mcp-sessions-home-'));
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-sessions-'));
  process.env.DISPATCH_HOME = fakeHome;
  delete process.env.DISPATCH_SESSIONS;
  delete process.env.DISPATCH_AGENT_NAME;
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
    ['commit', '--allow-empty', '-m', 'initial commit'],
  ])
    Bun.spawnSync(['git', ...args], { cwd: root });
  TaskStore.init(root);

  child = Bun.spawn(
    ['bun', resolveDaemonBin(), '--root', root, '--port', '0'],
    {
      env: {
        ...process.env,
        DISPATCH_HOME: fakeHome,
        DISPATCH_APP_TOKEN: APP_TOKEN,
      },
      stdout: 'ignore',
      stderr: 'pipe',
    }
  );
  const deadline = Date.now() + 10_000;
  for (;;) {
    const info = readDaemonFile(root);
    if (info !== null && (await isDaemonHealthy(info.port))) {
      baseUrl = `http://127.0.0.1:${info.port}`;
      break;
    }
    if (child.exitCode !== null || Date.now() > deadline)
      throw new Error(await new Response(child.stderr).text());
    await Bun.sleep(50);
  }
  await seedApprovedClientIdentity();
});

afterAll(() => {
  child.kill();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// Registers the client identity the MCP would, caches it where the MCP looks,
// and approves it as the owner: the state after a human approved the client.
async function seedApprovedClientIdentity(): Promise<void> {
  const daemon = readDaemonFile(root)!;
  const name = agentName({}, CLIENT, hostname());
  const res = await fetch(`${baseUrl}/api/agents/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${daemon.agentToken}`,
    },
    body: JSON.stringify({ name, client: CLIENT }),
  });
  const created = (await res.json()) as { address: string; token: string };
  const path = agentTokenFilePath(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(created), { mode: 0o600 });
  await fetch(
    `${baseUrl}/api/agents/${encodeURIComponent(created.address)}/approve`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${APP_TOKEN}`,
      },
    }
  );
}

// One MCP session: its own server and client, its tool calls made with its
// own session id in the environment (the id an agent client would export).
async function session(
  id: string
): Promise<(name: string, args?: object) => Promise<ToolCallResult>> {
  const server = createDispatchMcpServer(root, { unreadCacheMs: 0 });
  const client = new Client({ name: CLIENT, version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return async (name, args = {}) => {
    process.env.DISPATCH_SESSION_ID = id;
    return (await client.callTool({
      name,
      arguments: args as Record<string, unknown>,
    })) as ToolCallResult;
  };
}

function lastText(result: ToolCallResult): string {
  return result.content.at(-1)?.text ?? '';
}

describe('MCP sessions (live daemon)', () => {
  it('gives each session an address, presence and unread notice', async () => {
    const alpha = await session('alpha');
    const beta = await session('beta');

    const a = (await alpha('whoami')).structuredContent!;
    const b = (await beta('whoami')).structuredContent!;
    expect(a.kind).toBe('session');
    expect(b.kind).toBe('session');
    expect(a.address).toMatch(/^agent:test\/test-client-[0-9a-f]{6}$/);
    expect(b.address).not.toBe(a.address);
    expect(a.parent).toBe(b.parent);

    await alpha('session_label', { label: 'auth refactor' });
    const listed = (await beta('agent_list')).structuredContent!.agents as {
      address: string;
      kind: string;
      online: boolean;
      label?: string;
      branch?: string;
      you?: boolean;
    }[];
    const alphaRow = listed.find((r) => r.address === a.address);
    expect(alphaRow).toMatchObject({
      kind: 'session',
      online: true,
      label: 'auth refactor',
      branch: 'main',
    });
    expect(listed.find((r) => r.address === b.address)?.you).toBe(true);

    const sent = await beta('msg_send', {
      to: [a.address],
      kind: 'message',
      body: 'can you take the migration?',
    });
    expect(sent.isError).toBeUndefined();

    const next = await alpha('task_list');
    expect(lastText(next)).toBe(
      `[dispatch] 1 unread (from ${String(b.address)}). Call inbox_read.`
    );
    expect(next._meta?.['dispatch/unread']).toBe(1);

    const inbox = await alpha('inbox_read');
    expect(JSON.stringify(inbox.structuredContent)).toContain(
      'can you take the migration?'
    );
    expect(lastText(await alpha('task_list'))).not.toContain('[dispatch]');
  });
});
