import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildTuiLaunch,
  resolveTuiEntry,
  runTui,
} from '../src/commands/tui.js';
import { CliError } from '../src/context.js';

// A fake checkout: <root>/apps/tui/src/main.tsx plus a nested dir to start the walk from.
function checkout(): { root: string; nested: string; entry: string } {
  const root = mkdtempSync(join(tmpdir(), 'tui-checkout-'));
  const entry = join(root, 'apps', 'tui', 'src', 'main.tsx');
  mkdirSync(join(root, 'apps', 'tui', 'src'), { recursive: true });
  writeFileSync(entry, '');
  const nested = join(root, 'packages', 'cli', 'dist');
  mkdirSync(nested, { recursive: true });
  writeFileSync(
    join(root, 'packages', 'cli', 'package.json'),
    '{"name":"@dispatch/cli"}'
  );
  return { root, nested, entry };
}

describe('resolveTuiEntry', () => {
  it('prefers DISPATCH_TUI_ENTRY', () => {
    expect(
      resolveTuiEntry({ DISPATCH_TUI_ENTRY: '/opt/tui/main.js' }, '/nowhere')
    ).toBe('/opt/tui/main.js');
  });

  it("finds apps/tui/src/main.tsx in the CLI's own checkout", () => {
    const { nested, entry } = checkout();
    expect(resolveTuiEntry({}, nested)).toBe(entry);
  });

  it('ignores an apps/tui in an ancestor that is not the checkout the CLI runs from', () => {
    // e.g. a global install under a home directory that happens to hold apps/tui/src/main.tsx
    const { root } = checkout();
    const install = join(
      root,
      'lib',
      'node_modules',
      '@dispatch-foo',
      'cli',
      'dist'
    );
    mkdirSync(install, { recursive: true });
    expect(() => resolveTuiEntry({}, install)).toThrow(CliError);
  });

  it('outside a checkout, says how to point at a TUI build', () => {
    const lonely = mkdtempSync(join(tmpdir(), 'tui-none-'));
    expect(() => resolveTuiEntry({}, lonely)).toThrow(CliError);
    expect(() => resolveTuiEntry({}, lonely)).toThrow(/DISPATCH_TUI_ENTRY/);
  });
});

describe('buildTuiLaunch', () => {
  it('passes root and port as args and the token only in the environment', () => {
    const launch = buildTuiLaunch({
      entry: '/repo/apps/tui/src/main.tsx',
      root: '/repo',
      port: 4100,
      token: 'secret-token',
      env: { PATH: '/usr/bin' },
    });
    expect(launch.cmd).toBe('bun');
    expect(launch.args).toEqual([
      '/repo/apps/tui/src/main.tsx',
      '--root',
      '/repo',
      '--port',
      '4100',
    ]);
    expect(launch.args.join(' ')).not.toContain('secret-token');
    expect(launch.env.DISPATCH_TUI_TOKEN).toBe('secret-token');
    expect(launch.env.PATH).toBe('/usr/bin');
  });
});

describe('buildTuiLaunch tokens', () => {
  it('with an app token, the TUI gets it and may decide', () => {
    const launch = buildTuiLaunch({
      entry: '/e',
      root: '/r',
      port: 1,
      token: 'agent-tok',
      appToken: 'app-tok',
      env: {},
    });
    expect(launch.env.DISPATCH_TUI_TOKEN).toBe('app-tok');
    expect(launch.env.DISPATCH_TUI_CAN_DECIDE).toBe('1');
    expect(launch.args.join(' ')).not.toContain('app-tok');
  });

  it('without one, it runs read-only on the agent token', () => {
    const launch = buildTuiLaunch({
      entry: '/e',
      root: '/r',
      port: 1,
      token: 'agent-tok',
      env: {},
    });
    expect(launch.env.DISPATCH_TUI_TOKEN).toBe('agent-tok');
    expect(launch.env.DISPATCH_TUI_CAN_DECIDE).toBeUndefined();
  });
});

describe('runTui', () => {
  it('a missing bun is an actionable error, not a stack trace', async () => {
    const launch = {
      cmd: 'definitely-not-bun-xyz',
      args: [],
      env: { PATH: '/nonexistent' },
    };
    await expect(runTui(launch)).rejects.toThrow(/bun/);
    await expect(runTui(launch)).rejects.toBeInstanceOf(CliError);
  });

  it("returns the TUI's exit code", async () => {
    const code = await runTui({
      cmd: 'sh',
      args: ['-c', 'exit 3'],
      env: process.env as Record<string, string>,
    });
    expect(code).toBe(3);
  });
});
