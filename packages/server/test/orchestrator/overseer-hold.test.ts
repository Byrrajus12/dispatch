import { describe, expect, test } from 'bun:test';

import { overseerHoldFor } from '../../src/orchestrator/overseerHold.js';

const ROOT = '/work/shop';
const bash = (command: string) => overseerHoldFor('Bash', { command }, ROOT);

describe('the Dispatch CLI', () => {
  test.each([
    'dispatch task create "x"',
    'dispatch',
    'cd app && dispatch run t-1',
    'echo hi; dispatch task list',
    'FOO=1 dispatch task save',
    './node_modules/.bin/dispatch task create',
    '/usr/local/bin/dispatch status',
    'bunx dispatch task create',
    'pnpm exec dispatch task create',
    'npx dispatch task create',
    'echo $(dispatch task list)',
    'true || dispatch task drop t-1',
  ])('%p is held', (command) => {
    expect(bash(command)).toBe('dispatch-cli');
  });

  test.each([
    'echo dispatch',
    'grep -rn dispatch src',
    'git log --grep dispatch',
    'cat README.md',
    'ls packages/dispatch-ui',
  ])('%p runs', (command) => {
    expect(bash(command)).toBeNull();
  });
});

describe('the daemon API', () => {
  test.each([
    'curl -s http://127.0.0.1:4321/api/tasks',
    'curl -X POST localhost:57999/api/runs -d {}',
    'wget -qO- http://[::1]:4321/api/decisions',
    'http POST 0.0.0.0:4321/api/messages',
  ])('%p is held', (command) => {
    expect(bash(command)).toBe('daemon-api');
  });

  test('reading the daemon token file is held', () => {
    expect(bash('cat ~/.dispatch/daemons/abc123.json')).toBe('daemon-api');
  });

  test('another site is not the daemon', () => {
    expect(bash('curl -s https://example.com/api/x')).toBeNull();
  });
});

describe('.dispatch/ files', () => {
  test.each([
    ['Write', { file_path: '/work/shop/.dispatch/tasks/t-1.md', content: '' }],
    [
      'Edit',
      { file_path: '.dispatch/config.yml', old_string: 'a', new_string: 'b' },
    ],
    ['MultiEdit', { file_path: '/work/shop/.dispatch/inbox.md', edits: [] }],
    ['NotebookEdit', { notebook_path: '/work/shop/.dispatch/x.ipynb' }],
  ])('%s into .dispatch/ is held', (tool, input) => {
    expect(overseerHoldFor(tool, input, ROOT)).toBe('dispatch-files');
  });

  test.each([
    'rm .dispatch/tasks/t-1.md',
    'sed -i s/a/b/ .dispatch/config.yml',
    'echo x > .dispatch/tasks/t-9.md',
    'mv /work/shop/.dispatch/tasks/a.md b.md',
    'tee -a .dispatch/inbox.md',
  ])('shell writes into .dispatch/ are held: %p', (command) => {
    expect(bash(command)).toBe('dispatch-files');
  });

  test('reading .dispatch/ runs', () => {
    expect(bash('cat .dispatch/tasks/t-1.md')).toBeNull();
    expect(
      overseerHoldFor(
        'Read',
        { file_path: '/work/shop/.dispatch/tasks/t-1.md' },
        ROOT
      )
    ).toBeNull();
  });

  test('editing ordinary files runs', () => {
    expect(
      overseerHoldFor('Edit', { file_path: '/work/shop/src/app.ts' }, ROOT)
    ).toBeNull();
    expect(
      overseerHoldFor(
        'Write',
        { file_path: '/work/shop/docs/dispatch.md' },
        ROOT
      )
    ).toBeNull();
  });
});

describe('Codex calls', () => {
  test('a Codex edit inside .dispatch is held, any other runs', () => {
    expect(
      overseerHoldFor(
        'codex.fileChange',
        { paths: ['/work/shop/src/a.ts', '/work/shop/.dispatch/config.yml'] },
        ROOT
      )
    ).toBe('dispatch-files');
    expect(
      overseerHoldFor(
        'codex.fileChange',
        { paths: ['/work/shop/src/a.ts'] },
        ROOT
      )
    ).toBeNull();
    expect(overseerHoldFor('codex.fileChange', {}, ROOT)).toBeNull();
  });

  test('a Codex command reaching the Dispatch CLI is held', () => {
    expect(
      overseerHoldFor(
        'codex.commandExecution',
        { command: 'dispatch task list', cwd: ROOT },
        ROOT
      )
    ).toBe('dispatch-cli');
  });
});

describe('what hides a held command', () => {
  test.each([
    'env dispatch task list',
    'env -i PATH=/bin dispatch task list',
    'command dispatch task list',
    'exec dispatch task list',
    'nohup nice -n 5 dispatch run t-1',
    'timeout 30 dispatch task list',
    'sudo -E dispatch task list',
    'xargs dispatch task drop < ids',
    '"dispatch" task list',
    "d'is'patch task list",
    'dis\\patch task list',
  ])('%p is held', (command) => {
    expect(bash(command)).toBe('dispatch-cli');
  });

  test('letter case does not hide a .dispatch write or the daemon file', () => {
    expect(bash('echo x > .DISPATCH/config.yml')).toBe('dispatch-files');
    expect(bash('cat .Dispatch/daemons/d.json')).toBe('daemon-api');
    expect(
      overseerHoldFor('Write', { file_path: '.Dispatch/config.yml' }, ROOT)
    ).toBe('dispatch-files');
  });

  test('quoting does not hide a .dispatch write', () => {
    expect(bash(`echo x > ".dis""patch/config.yml"`)).toBe('dispatch-files');
  });
});

describe('Codex permission asks', () => {
  const ask = (fileSystem: unknown) =>
    overseerHoldFor(
      'codex.permissions',
      { permissions: { network: null, fileSystem } },
      ROOT
    );

  test('a write root under .dispatch is held', () => {
    expect(ask({ read: null, write: ['.dispatch'] })).toBe('dispatch-files');
    expect(
      ask({
        read: null,
        write: null,
        entries: [
          {
            path: { type: 'path', path: `${ROOT}/.dispatch/x` },
            access: 'write',
          },
        ],
      })
    ).toBe('dispatch-files');
  });

  test('a write root outside the checkout, or one with no plain path, is held', () => {
    expect(ask({ read: null, write: ['/etc'] })).toBe('outside-checkout');
    expect(ask({ read: null, write: ['../other'] })).toBe('outside-checkout');
    expect(
      ask({
        read: null,
        write: null,
        entries: [
          { path: { type: 'glob_pattern', pattern: '**' }, access: 'write' },
        ],
      })
    ).toBe('outside-checkout');
  });

  test('reads and writes inside the checkout are not held', () => {
    expect(ask({ read: ['/etc'], write: [`${ROOT}/build`] })).toBeNull();
    expect(ask(null)).toBeNull();
  });
});
