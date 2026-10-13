import { describe, expect, it } from 'bun:test';
import { delimiter, join } from 'node:path';

import { whichOnPath, widenPath } from '../src/setup/path.js';

const io = (over: Partial<Parameters<typeof widenPath>[1]> = {}) => ({
  home: '/Users/me',
  env: {},
  platform: 'darwin' as const,
  listDir: () => [] as string[],
  readText: () => null,
  ...over,
});

describe('widenPath', () => {
  it('appends standard install dirs without duplicating or reordering', () => {
    const out = widenPath('/usr/bin:/usr/local/bin', io()).split(':');
    expect(out.slice(0, 2)).toEqual(['/usr/bin', '/usr/local/bin']);
    expect(out.filter((p) => p === '/usr/local/bin')).toHaveLength(1);
    for (const dir of [
      '/opt/homebrew/bin',
      '/Users/me/.local/bin',
      '/Users/me/.claude/local',
      '/Users/me/.bun/bin',
      '/Users/me/.cargo/bin',
      '/Users/me/.npm-global/bin',
      '/Users/me/.volta/bin',
    ]) {
      expect(out).toContain(dir);
    }
  });

  it("uses nvm's default alias when it names an installed version", () => {
    const out = widenPath(
      '',
      io({
        readText: (p) => (p === '/Users/me/.nvm/alias/default' ? '22\n' : null),
        listDir: (p) =>
          p === '/Users/me/.nvm/versions/node'
            ? ['v20.1.0', 'v22.3.0', 'v24.3.0']
            : [],
      })
    );
    expect(out).toContain('/Users/me/.nvm/versions/node/v22.3.0/bin');
    expect(out).not.toContain('v24.3.0');
  });

  it('falls back to the newest nvm node when the alias is missing', () => {
    const out = widenPath(
      '',
      io({
        listDir: (p) =>
          p === '/Users/me/.nvm/versions/node'
            ? ['v9.0.0', 'v24.3.0', 'v22.3.0']
            : [],
      })
    );
    expect(out).toContain('/Users/me/.nvm/versions/node/v24.3.0/bin');
  });

  it('includes PNPM_HOME when set', () => {
    expect(
      widenPath('', io({ env: { PNPM_HOME: '/Users/me/Library/pnpm' } }))
    ).toContain('/Users/me/Library/pnpm');
  });
});

describe('whichOnPath', () => {
  it('returns the first executable match', () => {
    const exec = (p: string) => p === '/b/claude' || p === '/c/claude';
    expect(whichOnPath('claude', '/a:/b:/c', exec)).toBe('/b/claude');
    expect(whichOnPath('codex', '/a:/b', exec)).toBeNull();
  });

  it('finds a Windows install that only exists as name.exe', () => {
    const dirs = [join('C:', 'a'), join('C:', 'Users', 'me', '.local', 'bin')];
    const exe = join(dirs[1], 'claude') + '.EXE';
    const exec = (p: string) => p === exe;
    expect(whichOnPath('claude', dirs.join(delimiter), exec, 'win32')).toBe(
      exe
    );
    expect(
      whichOnPath('claude', dirs.join(delimiter), exec, 'darwin')
    ).toBeNull();
  });
});
