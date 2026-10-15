import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readTeamFile,
  teamReplica,
  teamServer,
  writeTeamFile,
} from '../src/hub/team.js';
import { createDispatchMcpServer } from '../src/index.js';

// Signing a machine in to a team: what is saved, and what dispatch_login
// says about it. The link itself runs against the real team service in the
// dispatch-relay repo's mesh test.

let home: string;
const saved = {
  DISPATCH_HOME: process.env.DISPATCH_HOME,
  DISPATCH_TEAM_URL: process.env.DISPATCH_TEAM_URL,
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-team-home-'));
  process.env.DISPATCH_HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

const file = {
  server: 'https://team.example',
  token: 'device-token',
  handle: 'ada',
  team: { id: 'team_Ab-c_9', name: 'Core' },
  device: 'dev_1',
};

describe('team sign-in', () => {
  it('saves the sign-in readable only by this user', () => {
    writeTeamFile(file);
    expect(readTeamFile()).toEqual(file);
    expect(
      statSync(join(home, '.dispatch', 'hub', 'team.json')).mode & 0o777
    ).toBe(0o600);
  });

  it('names the team replica as the team service does', () => {
    expect(teamReplica('team_Ab-c_9')).toBe('@team-team_Ab-c_9');
  });

  it('defaults to the hosted team service, overridable', () => {
    delete process.env.DISPATCH_TEAM_URL;
    expect(teamServer()).toBe('https://app.dispatch.foo');
    process.env.DISPATCH_TEAM_URL = 'http://localhost:9000/';
    expect(teamServer()).toBe('http://localhost:9000');
  });

  it('dispatch_login reports a machine already signed in', async () => {
    writeTeamFile(file);
    const server = createDispatchMcpServer(home);
    const client = new Client({ name: 'claude-code', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    const result = (await client.callTool({
      name: 'dispatch_login',
      arguments: {},
    })) as {
      structuredContent?: Record<string, unknown>;
    };
    expect(result.structuredContent).toEqual({
      status: 'signed-in',
      team: 'Core',
      handle: 'ada',
    });
  });
});
