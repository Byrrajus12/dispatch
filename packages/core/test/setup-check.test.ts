// packages/core/test/setup-check.test.ts
import { describe, expect, it } from 'bun:test';

import { runSetupCheck, type SetupCheckDeps } from '../src/setup/check.js';
import type { ProbeResult } from '../src/setup/types.js';

type Script = Record<string, ProbeResult>;
const ok = (stdout = ''): ProbeResult => ({ status: 0, stdout, stderr: '' });
const fail = (stderr = ''): ProbeResult => ({ status: 1, stdout: '', stderr });

// `installed` names binaries on PATH; `script` answers "<binary> <args…>" probes.
function deps(
  installed: string[],
  script: Script,
  over: Partial<SetupCheckDeps> = {}
): SetupCheckDeps {
  return {
    path: '/bin',
    which: (b) => (installed.includes(b) ? `/bin/${b}` : null),
    run: (command, args) => {
      const key = `${command.replace('/bin/', '')} ${args.join(' ')}`.trim();
      return Promise.resolve(
        script[key] ?? {
          status: null,
          stdout: '',
          stderr: '',
          error: `unscripted: ${key}`,
        }
      );
    },
    env: {},
    savedAgentKeys: {},
    ...over,
  };
}

const GIT_OK: Script = {
  'git --version': ok('git version 2.50.0'),
  'git config --get user.name': ok('Ada\n'),
  'git config --get user.email': ok('ada@example.com\n'),
};
const CLAUDE_IN: Script = {
  'claude --version': ok('2.1.290 (Claude Code)'),
  'claude auth status --json': ok('{"loggedIn":true}'),
};

const step = (r: Awaited<ReturnType<typeof runSetupCheck>>, id: string) =>
  r.steps.find((s) => s.id === id)!;

describe('runSetupCheck', () => {
  it('reports everything ok for an equipped machine', async () => {
    const r = await runSetupCheck(
      { rootDir: '/p', defaultExecutor: 'claude' },
      deps(['git', 'claude', 'curl', 'bash'], {
        ...GIT_OK,
        ...CLAUDE_IN,
        'git -C /p rev-parse --is-inside-work-tree': ok('true'),
        'git -C /p rev-parse --verify HEAD': ok('abc'),
      })
    );
    expect(r.steps.map((s) => [s.id, s.status])).toEqual([
      ['git', 'ok'],
      ['project', 'ok'],
      ['agent', 'ok'],
    ]);
    expect(r.defaultProvider).toBe('claude');
  });

  it('asks for git identity when name or email is missing', async () => {
    const r = await runSetupCheck(
      {},
      deps(['git'], {
        'git --version': ok('git version 2'),
        'git config --get user.name': fail(),
        'git config --get user.email': ok('a@b.c'),
      })
    );
    expect(step(r, 'git')).toMatchObject({
      status: 'needs-action',
      fix: { kind: 'git-identity' },
    });
  });

  it('offers to install git when it is missing', async () => {
    const r = await runSetupCheck({}, deps([], {}));
    expect(step(r, 'git')).toMatchObject({
      status: 'missing',
      fix: { kind: 'install-git' },
    });
  });

  it('omits the project step without a root', async () => {
    const r = await runSetupCheck({}, deps(['git'], GIT_OK));
    expect(r.steps.map((s) => s.id)).toEqual(['git', 'agent']);
  });

  it('offers to prepare a folder that is not a repo', async () => {
    const r = await runSetupCheck(
      { rootDir: '/p' },
      deps(['git'], {
        ...GIT_OK,
        'git -C /p rev-parse --is-inside-work-tree': fail(
          'fatal: not a git repository'
        ),
      })
    );
    expect(step(r, 'project')).toMatchObject({
      status: 'needs-action',
      fix: { kind: 'prepare-folder' },
    });
  });

  it('offers a first snapshot for a repo with no commits', async () => {
    const r = await runSetupCheck(
      { rootDir: '/p' },
      deps(['git'], {
        ...GIT_OK,
        'git -C /p rev-parse --is-inside-work-tree': ok('true'),
        'git -C /p rev-parse --verify HEAD': fail(
          'fatal: Needed a single revision'
        ),
      })
    );
    expect(step(r, 'project')).toMatchObject({
      status: 'needs-action',
      fix: { kind: 'prepare-folder', label: 'Save a first snapshot' },
    });
  });

  it('marks an installed agent that will not start as broken with a reinstall fix', async () => {
    const r = await runSetupCheck(
      { defaultExecutor: 'codex' },
      deps(['git', 'codex', 'npm'], {
        ...GIT_OK,
        'codex --version': fail('Error: spawn /x/codex/vendor/codex ENOENT'),
      })
    );
    const codex = r.providers.find((p) => p.id === 'codex')!;
    expect(codex).toMatchObject({
      installed: true,
      works: false,
      ready: false,
    });
    expect(codex.install).toMatchObject({
      kind: 'run',
      label: 'Reinstall Codex',
    });
    expect(step(r, 'agent')).toMatchObject({ status: 'needs-action' });
  });

  it('asks to sign in when the default agent is signed out', async () => {
    const r = await runSetupCheck(
      { defaultExecutor: 'claude' },
      deps(['git', 'claude'], {
        ...GIT_OK,
        'claude --version': ok('2'),
        'claude auth status --json': ok('{"loggedIn":false}'),
      })
    );
    expect(step(r, 'agent')).toMatchObject({
      status: 'needs-action',
      fix: { kind: 'run', command: ['claude', 'auth', 'login'] },
    });
  });

  it('treats a saved API key as ready even when signed out', async () => {
    const r = await runSetupCheck(
      { defaultExecutor: 'claude' },
      deps(
        ['git', 'claude'],
        {
          ...GIT_OK,
          'claude --version': ok('2'),
          'claude auth status --json': ok('{"loggedIn":false}'),
        },
        { savedAgentKeys: { ANTHROPIC_API_KEY: 'sk' } }
      )
    );
    expect(r.providers.find((p) => p.id === 'claude')).toMatchObject({
      usingApiKey: true,
      ready: true,
    });
    expect(step(r, 'agent').status).toBe('ok');
  });

  it('reports unknown (not blocking) when sign-in cannot be checked', async () => {
    const r = await runSetupCheck(
      { defaultExecutor: 'opencode' },
      deps(['git', 'opencode'], { ...GIT_OK, 'opencode --version': ok('1') })
    );
    expect(step(r, 'agent').status).toBe('unknown');
    expect(r.providers.find((p) => p.id === 'opencode')!.ready).toBe(true);
  });

  it('reports unknown when the auth probe times out', async () => {
    const r = await runSetupCheck(
      { defaultExecutor: 'claude' },
      deps(['git', 'claude'], {
        ...GIT_OK,
        'claude --version': ok('2'),
        'claude auth status --json': {
          status: null,
          stdout: '',
          stderr: '',
          error: 'timed out after 10000ms',
        },
      })
    );
    expect(r.providers.find((p) => p.id === 'claude')!.auth).toBe('unknown');
    expect(step(r, 'agent').status).toBe('unknown');
  });

  it('says no agent is installed and falls back to the first ready one as default', async () => {
    const none = await runSetupCheck({}, deps(['git', 'curl', 'bash'], GIT_OK));
    expect(step(none, 'agent')).toMatchObject({
      status: 'missing',
      fix: { kind: 'run', label: 'Install Claude Code' },
    });

    const codexOnly = await runSetupCheck(
      { defaultExecutor: 'claude' },
      deps(['git', 'codex'], {
        ...GIT_OK,
        'codex --version': ok('0.1'),
        'codex login status': ok('Logged in'),
      })
    );
    expect(codexOnly.defaultProvider).toBe('codex');
  });

  it('says the default agent is not installed (not broken) when only another agent is broken', async () => {
    const r = await runSetupCheck(
      {},
      deps(['git', 'codex', 'curl', 'bash'], {
        ...GIT_OK,
        'codex --version': fail('boom'),
      })
    );
    const agent = step(r, 'agent');
    expect(agent).toMatchObject({
      status: 'missing',
      fix: { label: 'Install Claude Code' },
    });
    expect(agent.message).not.toContain("won't start");
  });
});
