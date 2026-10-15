import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SetupEnv } from '../src/setup.js';
import { claudeHooks, connectClients, launchFor } from '../src/setup.js';

// `setup` wires every agent client it finds, once, and never clobbers a
// config it cannot read.

let home: string;
let ran: string[][];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-setup-home-'));
  ran = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function env(binaries: string[], status = 0): SetupEnv {
  return {
    home,
    platform: 'linux',
    has: (b) => binaries.includes(b),
    run: (command, args) => {
      ran.push([command, ...args]);
      return status;
    },
  };
}

const json = (path: string) =>
  JSON.parse(readFileSync(join(home, path), 'utf8')) as Record<string, unknown>;

describe('setup', () => {
  it('connects every client it finds, with the fast binary when installed', () => {
    for (const dir of [
      '.cursor',
      '.codex',
      '.gemini',
      '.config/Claude',
      '.codeium/windsurf',
    ])
      mkdirSync(join(home, dir), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');
    writeFileSync(
      join(home, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x' } } })
    );

    const e = env(['claude', 'dispatch-mcp']);
    const results = connectClients(e);
    expect(results.map((r) => `${r.client}:${r.status}`)).toEqual([
      'Claude Code:added',
      'Claude Code hooks:added',
      'Codex:added',
      'Cursor:added',
      'Gemini CLI:added',
      'Claude Desktop:added',
      'Windsurf:added',
    ]);
    expect(ran).toEqual([
      ['claude', 'mcp', 'add', '-s', 'user', 'dispatch', '--', 'dispatch-mcp'],
    ]);
    expect(json('.cursor/mcp.json').mcpServers).toEqual({
      other: { command: 'x' },
      dispatch: { command: 'dispatch-mcp', args: [] },
    });
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(
      'model = "gpt-5"\n\n[mcp_servers.dispatch]\ncommand = "dispatch-mcp"\nargs = []\n'
    );
    const hooks = json('.claude/settings.json').hooks as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(hooks)).toContain('dispatch-mcp hook claude wait');
  });

  it('adds nothing twice on a second run', () => {
    mkdirSync(join(home, '.cursor'), { recursive: true });
    mkdirSync(join(home, '.claude'), { recursive: true });
    connectClients(env(['claude']));
    const second = connectClients(env(['claude'], 1));
    expect(second.map((r) => r.status)).toEqual([
      'present',
      'present',
      'present',
    ]);
    const stop = (
      json('.claude/settings.json').hooks as Record<string, unknown[]>
    ).Stop;
    expect(stop).toHaveLength(1);
  });

  it('keeps the person’s own hooks and leaves unreadable configs alone', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'opus',
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
        },
      })
    );
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{ // a comment\n}');
    const results = connectClients(env(['claude']));
    expect(results.find((r) => r.client === 'Cursor')?.status).toBe('skipped');
    expect(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).toBe(
      '{ // a comment\n}'
    );
    const settings = json('.claude/settings.json');
    expect(settings.model).toBe('opus');
    expect((settings.hooks as Record<string, unknown[]>).Stop).toHaveLength(2);
  });

  it('falls back to npx when the binary is not installed', () => {
    expect(launchFor(env([]))).toEqual({
      command: 'npx',
      args: ['-y', '@dispatch-foo/mcp'],
    });
    expect(
      JSON.stringify(
        claudeHooks({ command: 'npx', args: ['-y', '@dispatch-foo/mcp'] })
      )
    ).toContain('npx -y @dispatch-foo/mcp hook claude UserPromptSubmit');
  });
});

describe('opening the browser', () => {
  it('opens only https URLs on the team server', async () => {
    const { safeToOpen } = await import('../src/setup.js');
    expect(
      safeToOpen(
        'https://app.dispatch.foo/device?code=AB',
        'https://app.dispatch.foo'
      )
    ).toBe(true);
    expect(
      safeToOpen('https://evil.example/device', 'https://app.dispatch.foo')
    ).toBe(false);
    expect(
      safeToOpen('http://app.dispatch.foo/device', 'http://app.dispatch.foo')
    ).toBe(false);
    expect(
      safeToOpen('http://localhost:9000/device', 'http://localhost:9000')
    ).toBe(true);
    expect(safeToOpen('file:///etc/passwd', 'https://app.dispatch.foo')).toBe(
      false
    );
  });

  it('keeps a config file’s own permissions', () => {
    const { chmodSync, statSync } =
      require('node:fs') as typeof import('node:fs');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{}');
    chmodSync(join(home, '.cursor', 'mcp.json'), 0o600);
    connectClients(env([]));
    expect(statSync(join(home, '.cursor', 'mcp.json')).mode & 0o777).toBe(
      0o600
    );
  });
});

describe('global install', () => {
  it('installs the pinned version when npm is there, and uses it', async () => {
    const { installGlobally } = await import('../src/setup.js');
    const installed: string[] = [];
    const e: SetupEnv = {
      home,
      platform: 'linux',
      has: (b) => b === 'npm' || (b === 'dispatch-mcp' && installed.length > 0),
      run: (command, args) => {
        installed.push([command, ...args].join(' '));
        return 0;
      },
    };
    expect(installGlobally(e, '0.26.0')).toBe(true);
    expect(installed).toEqual([
      'npm install --global @dispatch-foo/mcp@0.26.0',
    ]);
    expect(launchFor(e)).toEqual({ command: 'dispatch-mcp', args: [] });
  });

  it('falls back quietly without npm', async () => {
    const { installGlobally } = await import('../src/setup.js');
    expect(installGlobally(env([]), '0.26.0')).toBe(false);
  });
});
