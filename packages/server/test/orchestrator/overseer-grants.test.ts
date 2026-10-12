import { describe, expect, test } from 'bun:test';

import {
  GRANT_TTL_MS,
  grantKey,
  GrantStore,
} from '../../src/orchestrator/overseerGrants.js';

describe('grantKey', () => {
  test('a Codex command is scoped to its program, like Bash', () => {
    expect(
      grantKey('codex.commandExecution', { command: 'git status', cwd: '/w' })
    ).toBe('codex.commandExecution:git');
    expect(grantKey('codex.fileChange', { paths: ['/w/a.ts'] })).toBe(
      'codex.fileChange'
    );
  });

  test('Bash is scoped to the program it runs', () => {
    expect(grantKey('Bash', { command: 'moonx desktop:test' })).toBe(
      'Bash:moonx'
    );
    expect(
      grantKey('Bash', { command: 'FOO=1 ./node_modules/.bin/vitest run' })
    ).toBe('Bash:vitest');
    expect(grantKey('Bash', { command: '  git status' })).toBe('Bash:git');
  });

  // One grant for `cd` or `env` must not cover whatever runs after it.
  test('a compound or wrapped command is scoped to its exact text', () => {
    for (const command of [
      'cd app && rm -rf build',
      'git status; rm -rf /',
      'ls | xargs rm',
      'echo $(whoami)',
      'echo `whoami`',
      'cat a > b',
      'env FOO=1 node x.js',
      'xargs rm',
      'sudo ls',
      'timeout 5 node x.js',
      "bash -c 'ls'",
      'nice   -n 5   make',
    ]) {
      expect(grantKey('Bash', { command })).toBe(
        `Bash:${command.trim().replace(/\s+/g, ' ')}`
      );
    }
    expect(
      grantKey('codex.commandExecution', { command: 'cd app && moonx test' })
    ).toBe('codex.commandExecution:cd app && moonx test');
  });

  test('quoting does not disguise a wrapper program', () => {
    expect(grantKey('Bash', { command: '"env" node x.js' })).toBe(
      'Bash:"env" node x.js'
    );
  });

  test('a Codex permissions grant names exactly what it requested', () => {
    const write = (roots: string[]) =>
      grantKey('codex.permissions', {
        permissions: {
          network: null,
          fileSystem: { write: roots, read: null },
        },
      });
    expect(write(['/w/build'])).toBe(
      'codex.permissions:{"fileSystem":{"read":null,"write":["/w/build"]},"network":null}'
    );
    expect(write(['/w/build'])).not.toBe(write(['/w/dist']));
  });

  test('other tools are scoped to the tool', () => {
    expect(grantKey('Edit', { file_path: 'a.ts' })).toBe('Edit');
  });
});

describe('GrantStore', () => {
  const now = Date.parse('2026-10-06T09:00:00Z');

  test('a grant allows the same key, not another program', () => {
    const store = new GrantStore();
    store.grant('c', 'Bash:moonx', now, 's-1');
    expect(store.allows('c', 'Bash:moonx', now, 's-1')).toBe(true);
    expect(store.allows('c', 'Bash:rm', now, 's-1')).toBe(false);
    expect(store.allows('other', 'Bash:moonx', now, 's-1')).toBe(false);
  });

  test('a grant ends after four hours', () => {
    const store = new GrantStore();
    store.grant('c', 'Edit', now, 's-1');
    expect(store.allows('c', 'Edit', now + GRANT_TTL_MS - 1, 's-1')).toBe(true);
    expect(store.allows('c', 'Edit', now + GRANT_TTL_MS, 's-1')).toBe(false);
    expect(store.list('c', now + GRANT_TTL_MS)).toEqual([]);
  });

  test('a grant ends at a context rollover (a new session)', () => {
    const store = new GrantStore();
    store.grant('c', 'Edit', now, 's-1');
    expect(store.allows('c', 'Edit', now, 's-2')).toBe(false);
  });

  test('grants are listed and revocable', () => {
    const store = new GrantStore();
    store.grant('c', 'Bash:moonx', now, 's-1');
    store.grant('c', 'Edit', now + 1000, 's-1');
    expect(store.list('c', now + 2000).map((g) => g.key)).toEqual([
      'Bash:moonx',
      'Edit',
    ]);
    expect(store.list('c', now + 2000)[0]).toEqual({
      key: 'Bash:moonx',
      grantedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + GRANT_TTL_MS).toISOString(),
    });
    expect(store.revoke('c', 'Bash:moonx')).toBe(true);
    expect(store.revoke('c', 'Bash:moonx')).toBe(false);
    expect(store.allows('c', 'Bash:moonx', now + 2000, 's-1')).toBe(false);
  });
});
