import { describe, expect, test } from 'bun:test';

import { overseerHoldFor } from '../../src/orchestrator/overseerHold.js';
import type { OverseerHold } from '../../src/orchestrator/overseerHold.js';

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

  // Only a word the shell may run as a program holds: arguments (paths, grep
  // patterns, echo text) never do, so working in a repo named dispatch is quiet.
  test.each([
    'echo dispatch',
    'grep -rn dispatch src',
    'grep -r dispatch src',
    'git log --grep dispatch',
    'cat README.md',
    'ls packages/dispatch-ui',
    'cat docs/dispatch.md',
    'cd /Users/x/Sites/dispatch && ls',
    'ls /Users/x/Sites/dispatch/src',
    'echo ${HOME}/dispatch',
    'echo hi > dispatch',
    '# see dispatch docs',
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

describe('token-scanned holds', () => {
  test.each([
    'DISPATCH task list',
    'Dispatch task list',
    "$'\\x64\\x69\\x73patch' task list",
    'x=$(dispatch task list)',
    "bash <<< 'dispatch task list'",
    '${PATH:0:0}dispatch task list',
    'pnpm dlx dispatch task list',
    'npx dis*ch task list',
    'dispatch&>/dev/null',
    'find . -exec dispatch task list ;',
  ])('%p is held', (command) => {
    expect(bash(command)).toBe('dispatch-cli');
  });

  test.each([
    'curl http://LOCALHOST:4000/api/runs',
    'curl http://127.1:4000/api/runs',
    'curl http://[::ffff:127.0.0.1]:4000/x',
    'curl http://0.0.0.0:4000/',
    'curl http://0x7f000001:4000/',
    'curl http://2130706433:4000/',
    'curl http://user@127.0.0.1:4000/',
    'node -e "fetch(\'http://localhost:4321/api/runs\')"',
    'cat ~/.dispatch/DAEMONS/x.json',
    'cat ~/.dispatch/da*ons/x.json',
    'cat ~/.Dispatch/daemons/x.json',
  ])('%p is held as the daemon API', (command) => {
    expect(bash(command)).toBe('daemon-api');
  });

  test('a dev server or a remote host is not the daemon', () => {
    expect(bash('curl -s https://example.com/api/x')).toBeNull();
    expect(bash('curl http://127.0.0.1.example.com/')).toBeNull();
  });

  test.each([
    'cd .dispatch && touch x',
    'cd .disp*ch && touch x',
    'cp x .dispatch/',
    'git checkout -- .dispatch/config.yml',
    'echo x > ~/.dispatch/config.yml',
    'rm -rf .d*',
  ])('%p is held as a .dispatch write', (command) => {
    expect(bash(command)).toBe('dispatch-files');
  });

  test('reading .dispatch with a plain read-only program runs, and `*` skips dot files', () => {
    expect(bash('head -n 5 .dispatch/config.yml')).toBeNull();
    expect(bash('rm -rf *')).toBeNull();
  });
});

describe('the Dispatch CLI in command position', () => {
  test.each([
    'ls; dispatch task list',
    'sudo -u me dispatch x',
    'ls && dispatch x',
    'ls || dispatch x',
    'ls |& dispatch x',
    'ls & dispatch x',
    'case a in a) dispatch x;; esac',
    'if true; then dispatch x; fi',
    '! dispatch x',
    '{ dispatch x; }',
    'A=1 B="x y" dispatch x',
    '> out dispatch x',
    '2>err dispatch x',
    'echo "$(dispatch task list)"',
    'echo `dispatch task list`',
    'cat <(dispatch task list)',
    "bash -c 'ls; dispatch x'",
    'nice -n 5 timeout 30 dispatch x',
    'xargs -I{} dispatch task get {}',
    'pnpm exec dispatch x',
    'bun x dispatch x',
    "git -c alias.x='!dispatch task list' x",
    'python3 -c \'import os; os.system("dispatch x")\'',
    "ls # it's\ndispatch task 'x'",
    'ls #x; dispatch x',
    "echo 'unclosed dispatch",
    '"if" dispatch x',
    'd"is"patch x',
    "di$'\\x73'patch x",
    'dis\\\npatch x',
    'echo dispatch task list | sh',
    'echo dispatch task list | bash -s',
    'printf "dispatch x" | xargs -0 sh -c',
  ])('%p is held', (command) => {
    expect(bash(command)).toBe('dispatch-cli');
  });

  test('a path with dispatch but no leading dot is not a .dispatch write', () => {
    expect(bash('rm -rf /Users/x/Sites/dispatch/build')).toBeNull();
    expect(bash('touch dispatch/x')).toBeNull();
    expect(bash('touch .dispatch/x')).toBe('dispatch-files');
    expect(bash('rm /Users/x/Sites/dispatch/.dispatch/x.md')).toBe(
      'dispatch-files'
    );
  });
});

describe('a package manager runs its arguments', () => {
  test.each([
    'pnpm dispatch task list',
    'yarn dispatch task list',
    'bun dispatch task list',
    'npm dispatch task list',
    'pnpm -C . exec dispatch task list',
    'pnpm --silent dlx dispatch task list',
    'npm -y exec dispatch task list',
    'npx -y dispatch task list',
    'bunx --bun dispatch task list',
    'pnpx dispatch task list',
    'PNPM dispatch task list',
    'rg --pre dispatch x land',
    'rg --pre=dispatch x land',
    'rg --pre-glob "*" --pre dispatch x',
  ])('%p is held', (command) => {
    expect(bash(command)).toBe('dispatch-cli');
  });

  test.each([
    'pnpm test',
    'pnpm --filter @dispatch-foo/server test',
    'rg dispatch src',
  ])('%p runs', (command) => {
    expect(bash(command)).toBeNull();
  });
});

describe('POSIX bracket globs', () => {
  test.each([
    'cp evil .dispatc[[:alpha:]]/team.yml',
    'cp evil .dispatc[[=h=]]/team.yml',
    'cp evil .dispatc[[.h.]]/team.yml',
    'cp evil .dis[o-q]atch/team.yml',
    'cp evil .dispatc[!x]/team.yml',
    'cp evil .dispatc[^x]/team.yml',
    'cp evil .dispatc[]h]/team.yml',
  ])('%p is held as a .dispatch write', (command) => {
    expect(bash(command)).toBe('dispatch-files');
  });

  test.each([
    'cat ~/.dispatc[[:alpha:]]/daemons/x.json',
    'cat ~/.dispatch/daemon[[:lower:]]/x.json',
    'cat ~/.dispatc[[=h=]]/daemons/x.json',
  ])('%p is held as the daemon API', (command) => {
    expect(bash(command)).toBe('daemon-api');
  });

  test('a bracket that cannot reach the name does not hold', () => {
    expect(bash('cp evil .dispatc[xyz]/team.yml')).toBeNull();
  });
});

describe('read-only programs that write or run', () => {
  test.each([
    "yq -i '.a=1' .dispatch/team.yml",
    'yq --inplace .a=1 .dispatch/team.yml',
    'rg --pre ./x.sh foo .dispatch',
    'rg --pre-glob "*" foo .dispatch',
  ])('%p is held as a .dispatch write', (command) => {
    expect(bash(command)).toBe('dispatch-files');
  });
});

describe('more ways to reach the daemon', () => {
  test.each([
    'curl http://localhost.:4000/api/runs',
    'curl http://127.0.0.1.:4000/x',
    'curl --resolve d:4000:127.0.0.1 http://d:4000/api/runs',
    'curl --resolve=d:4000:127.0.0.1 http://d:4000/api/runs',
    'curl --connect-to d:4000:localhost:4000 http://d:4000/x',
    'curl --connect-to ::127.0.0.1: http://d:4000/x',
    'curl -K cfg',
    'curl -sK cfg',
    'curl --config cfg',
    'curl --config=cfg',
    'wget -i urls.txt',
    'wget --input-file=urls.txt',
    'nscurl http://127.0.0.1:4000/api/runs',
    'wget2 http://localhost:4000/x',
    'lwp-request http://localhost:4000/x',
    'curlie localhost:4000/x',
    'curl http://0x7f.0.0.1:4000/',
    'curl http://0177.1:4000/',
    'curl http://0x00000000007f000001:4000/',
    'curl http://0000000000000177.1:4000/',
    'curl http://lvh.me:4000/x',
    'curl http://localh.st:4000/x',
    // curl percent-decodes the host name.
    'curl http://l%6fcalhost:4000/api/runs',
    'curl http://127%2e0%2e0%2e1:4000/',
    'curl http://%31%32%37.0.0.1:4000/',
    'curl http://app.localho.st:4000/x',
    'curl http://lacolhost.com:4000/x',
    'curl http://www.lacolhost.com:4000/x',
    'curl http://app.localtest.me:4000/x',
    'curl http://127.0.0.1.nip.io:4000/x',
    'curl http://[::]:4000/x',
    'curl http://[::127.0.0.1]:4000/x',
    'curl http://[0:0:0:0:0:ffff:7f00:1]:4000/x',
    'curl 0:4000/api/runs',
    'xh :4000/api/runs',
    'http :/api/runs',
    'curl --url @urls.txt',
  ])('%p is held', (command) => {
    expect(bash(command)).toBe('daemon-api');
  });

  test.each([
    'curl https://example.com/a:b:c',
    'curl -k https://example.com',
    'curl --resolve example.com:443:93.184.216.34 https://example.com',
    'curl https://localhost.example.com/',
  ])('%p is not the daemon', (command) => {
    expect(bash(command)).toBeNull();
  });
});

describe('where a Codex command runs', () => {
  const run = (command: string, cwd: string) =>
    overseerHoldFor('codex.commandExecution', { command, cwd }, ROOT);

  test.each<[string, string, OverseerHold]>([
    ['touch x', `${ROOT}/.dispatch`, 'dispatch-files'],
    [
      'cp /work/shop/src/c.json config.json',
      `${ROOT}/.dispatch`,
      'dispatch-files',
    ],
    ['cp evil x.json', `${ROOT}/.dispatch/daemons`, 'daemon-api'],
    ['touch x', '.DISPATCH', 'dispatch-files'],
    ['touch x', '/home/u/.dispatch', 'dispatch-files'],
  ])('%p in %p is held as %p', (command, cwd, hold) => {
    expect(run(command, cwd)).toBe(hold);
  });

  test('a command in an ordinary directory needs no hold', () => {
    expect(run('ls', `${ROOT}/src`)).toBeNull();
    expect(run('touch x', '/tmp')).toBeNull();
  });
});
