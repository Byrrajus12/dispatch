import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeTeamFile } from '../src/hub/team.js';
import { createDispatchMcpServer } from '../src/index.js';

// linear_* go to the team service with this machine's sign-in.

let home: string;
let server: ReturnType<typeof Bun.serve> | undefined;
let seen: {
  path: string;
  auth: string | null;
  body: Record<string, unknown>;
}[];
const saved = process.env.DISPATCH_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-linear-home-'));
  process.env.DISPATCH_HOME = home;
  seen = [];
});
afterEach(() => {
  void server?.stop(true);
  if (saved === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

async function client(): Promise<Client> {
  const s = createDispatchMcpServer(home);
  const c = new Client({ name: 'codex', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([c.connect(a), s.connect(b)]);
  return c;
}

describe('linear tools', () => {
  it('asks an unsigned machine to sign in first', async () => {
    const result = (await (
      await client()
    ).callTool({ name: 'linear_search', arguments: { query: 'auth' } })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('dispatch_login');
  });

  it("calls the team service with this machine's sign-in", async () => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        seen.push({
          path: new URL(req.url).pathname,
          auth: req.headers.get('authorization'),
          body: (await req.json()) as Record<string, unknown>,
        });
        return new URL(req.url).pathname.endsWith('/state')
          ? Response.json({ error: 'no state "Shipped"' }, { status: 400 })
          : Response.json({
              issues: [{ identifier: 'ENG-1', title: 'Fix auth' }],
            });
      },
    });
    writeTeamFile({
      server: `http://127.0.0.1:${server.port}`,
      token: 'device-token',
      handle: 'ada',
      team: { id: 'team_1', name: 'Core' },
      device: 'dev_1',
    });
    const c = await client();
    const found = (await c.callTool({
      name: 'linear_search',
      arguments: { query: 'auth' },
    })) as {
      structuredContent?: Record<string, unknown>;
    };
    expect(found.structuredContent).toEqual({
      issues: [{ identifier: 'ENG-1', title: 'Fix auth' }],
    });
    expect(seen[0]).toEqual({
      path: '/api/team/linear/search',
      auth: 'Bearer device-token',
      body: { query: 'auth' },
    });

    const moved = (await c.callTool({
      name: 'linear_state',
      arguments: { id: 'ENG-1', state: 'Shipped' },
    })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(moved.isError).toBe(true);
    expect(moved.content[0]?.text).toBe('no state "Shipped"');
  });
});
