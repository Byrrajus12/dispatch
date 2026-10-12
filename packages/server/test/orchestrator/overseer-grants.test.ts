import { describe, expect, test } from 'bun:test';

import {
  GRANT_TTL_MS,
  grantKey,
  GrantStore,
} from '../../src/orchestrator/overseerGrants.js';

describe('grantKey', () => {
  test('a Codex command is scoped to its program, like Bash', () => {
    expect(
      grantKey(
        'codex.commandExecution',
        { command: 'git status', cwd: '/w' },
        '/w'
      )
    ).toBe('codex.commandExecution:git');
    expect(grantKey('codex.fileChange', { paths: ['/w/a.ts'] })).toBe(
      'codex.fileChange'
    );
  });

  test('Bash is scoped to the program it runs', () => {
    expect(grantKey('Bash', { command: 'moonx desktop:test' })).toBe(
      'Bash:moonx'
    );
    // A leading assignment (`PATH=…`, `LD_PRELOAD=…`) can change what runs,
    // so it is no longer simple and grants only its exact text.
    expect(
      grantKey('Bash', { command: 'FOO=1 ./node_modules/.bin/vitest run' })
    ).toBe('Bash:FOO=1 ./node_modules/.bin/vitest run');
    // A program named by a path keeps that path: `./x.sh` is not `/tmp/x.sh`.
    expect(
      grantKey('Bash', { command: './node_modules/.bin/vitest run' })
    ).toBe('Bash:./node_modules/.bin/vitest');
    expect(grantKey('Bash', { command: './x.sh' })).not.toBe(
      grantKey('Bash', { command: '/tmp/x.sh' })
    );
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

  test('a program key needs a simple command: one program, plain arguments', () => {
    expect(grantKey('Bash', { command: 'Git status' })).toBe('Bash:git');
    for (const command of [
      'find . -exec rm {} +',
      'node -e "1"',
      'python3 -c "print(1)"',
      'git -c core.pager=x log',
      'ls *(e:x:)',
      'cat =(ls)',
      '! rm -rf build',
      'noglob rm -rf build',
      'caffeinate -i make',
      'dispatch\u00a0task list',
    ]) {
      expect(grantKey('Bash', { command })).toBe(
        `Bash:${command.replace(/[ \t]+/g, ' ')}`
      );
    }
  });

  test('blanks inside quotes stay as written in an exact-text key', () => {
    for (const [a, b] of [
      ['echo "a  b"; x', 'echo "a b"; x'],
      ["echo 'a\tb'; x", "echo 'a b'; x"],
      ["echo $'a\\'  b'; x", "echo $'a\\' b'; x"],
      ['echo a\\  b; x', 'echo a\\ b; x'],
    ]) {
      expect(grantKey('Bash', { command: a })).not.toBe(
        grantKey('Bash', { command: b })
      );
    }
    expect(grantKey('Bash', { command: 'ls;  echo "a  b"  ' })).toBe(
      'Bash:ls; echo "a  b"'
    );
  });

  test('a simple command that names Dispatch or a loopback host grants only its text', () => {
    expect(grantKey('Bash', { command: 'cat ~/.dispatch/config.yml' })).toBe(
      'Bash:cat ~/.dispatch/config.yml'
    );
    expect(
      grantKey('codex.commandExecution', { command: 'curl http://lvh.me/x' })
    ).toBe('codex.commandExecution:curl http://lvh.me/x');
    // The project's own path is not a hint.
    expect(
      grantKey(
        'Bash',
        { command: 'ls /Users/x/Sites/dispatch/src' },
        '/Users/x/Sites/dispatch'
      )
    ).toBe('Bash:ls');
  });

  test('a simple command naming a path outside the checkout grants only its text', () => {
    const root = '/Users/x/Sites/dispatch';
    for (const command of [
      'grep -r token ~',
      'ls /tmp',
      'ls /',
      'cat ../other/x',
    ]) {
      expect(grantKey('Bash', { command }, root)).toBe(`Bash:${command}`);
    }
    expect(grantKey('Bash', { command: 'ls src' }, root)).toBe('Bash:ls');
  });

  test('a Codex command run outside the checkout root keys by its directory', () => {
    const root = '/r';
    const at = (command: string, cwd: string) =>
      grantKey('codex.commandExecution', { command, cwd }, root);
    expect(at('touch x', '/r')).toBe('codex.commandExecution:touch');
    expect(at('touch x', '/r/src')).toBe(
      'codex.commandExecution:touch (in /r/src)'
    );
    // A `touch` grant made at the root never answers one inside .dispatch.
    expect(at('touch x', '/r/.dispatch')).not.toBe(at('touch y', '/r'));
    expect(at('touch x', '/r/.dispatch')).toBe(
      'codex.commandExecution:touch x (in /r/.dispatch)'
    );
    expect(at('cp id_rsa /r/leak', '/home/u/.ssh')).toBe(
      'codex.commandExecution:cp id_rsa /r/leak (in /home/u/.ssh)'
    );
  });

  test('newlines stay distinct from spaces in an exact-text key', () => {
    expect(
      grantKey('Bash', { command: 'echo ok; echo\nrm -rf build' })
    ).not.toBe(grantKey('Bash', { command: 'echo ok; echo rm -rf build' }));
    expect(grantKey('Bash', { command: 'echo  ok;\techo x' })).toBe(
      'Bash:echo ok; echo x'
    );
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
