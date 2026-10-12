// packages/core/src/setup/check.ts
import { execFile } from 'node:child_process';

import { childEnv } from '../childEnv.js';
import { readAgentKeys } from './agentEnv.js';
import { whichOnPath, widenedPath } from './path.js';
import { providerById, PROVIDERS, resolveInstallFix } from './providers.js';
import type {
  ProbeResult,
  ProviderSpec,
  ProviderState,
  SetupReport,
  SetupStep,
} from './types.js';

export interface SetupCheckInput {
  rootDir?: string;
  /** The orchestrator's configured executor name. */
  defaultExecutor?: string;
}

export interface SetupCheckDeps {
  path: string;
  which: (binary: string) => string | null;
  run: (
    command: string,
    args: readonly string[],
    opts: { cwd?: string; timeoutMs: number }
  ) => Promise<ProbeResult>;
  env: Record<string, string | undefined>;
  savedAgentKeys: Record<string, string>;
  /** Defaults to process.platform; tests pin it. */
  platform?: string;
}

const PROBE_TIMEOUT_MS = 10_000;

const firstLine = (r: ProbeResult) =>
  (
    r.error ?? (r.stderr.trim() !== '' ? r.stderr.trim() : r.stdout.trim())
  ).split('\n')[0];

// On macOS without the command line tools, /usr/bin/git is a stub that pops Apple's
// installer when run, so check for the tools before touching it.
async function isGitStub(git: string, deps: SetupCheckDeps): Promise<boolean> {
  if (
    (deps.platform ?? process.platform) !== 'darwin' ||
    git !== '/usr/bin/git'
  )
    return false;
  const tools = await deps.run('xcode-select', ['-p'], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return tools.status !== 0;
}

async function gitStep(deps: SetupCheckDeps): Promise<SetupStep> {
  const git = deps.which('git');
  if (
    git === null ||
    (await isGitStub(git, deps)) ||
    (await deps.run(git, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS }))
      .status !== 0
  ) {
    return {
      id: 'git',
      status: 'missing',
      message:
        "Git isn't installed yet. Dispatch uses it to keep each agent's work separate.",
      fix: { kind: 'install-git', label: 'Install Git' },
    };
  }
  const [name, email] = await Promise.all(
    ['user.name', 'user.email'].map((key) =>
      deps.run(git, ['config', '--get', key], { timeoutMs: PROBE_TIMEOUT_MS })
    )
  );
  if (
    name.status !== 0 ||
    name.stdout.trim() === '' ||
    email.status !== 0 ||
    email.stdout.trim() === ''
  ) {
    return {
      id: 'git',
      status: 'needs-action',
      message: 'Git needs your name and email to label saved changes.',
      fix: { kind: 'git-identity', label: 'Add your name and email' },
    };
  }
  return {
    id: 'git',
    status: 'ok',
    message: 'Git is installed and knows who you are.',
  };
}

async function projectStep(
  rootDir: string,
  deps: SetupCheckDeps
): Promise<SetupStep> {
  const git = deps.which('git');
  if (git === null || (await isGitStub(git, deps)))
    return { id: 'project', status: 'unknown', message: 'Install Git first.' };
  const inside = await deps.run(
    git,
    ['-C', rootDir, 'rev-parse', '--is-inside-work-tree'],
    { timeoutMs: PROBE_TIMEOUT_MS }
  );
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    return {
      id: 'project',
      status: 'needs-action',
      message: "This folder isn't set up for version tracking yet.",
      fix: { kind: 'prepare-folder', label: 'Turn on version tracking' },
      detail: firstLine(inside),
    };
  }
  const head = await deps.run(
    git,
    ['-C', rootDir, 'rev-parse', '--verify', 'HEAD'],
    { timeoutMs: PROBE_TIMEOUT_MS }
  );
  if (head.status !== 0) {
    return {
      id: 'project',
      status: 'needs-action',
      message:
        'Your project needs a first saved snapshot before an agent can work on it.',
      fix: { kind: 'prepare-folder', label: 'Save a first snapshot' },
    };
  }
  return { id: 'project', status: 'ok', message: 'Your project is ready.' };
}

async function providerState(
  spec: ProviderSpec,
  deps: SetupCheckDeps
): Promise<ProviderState> {
  const base = {
    id: spec.id,
    name: spec.name,
    blurb: spec.blurb,
    capabilities: spec.capabilities,
    ...(spec.apiKeyEnv === undefined ? {} : { apiKeyEnv: spec.apiKeyEnv }),
  };
  const has = (b: string) => deps.which(b) !== null;
  const usingApiKey =
    spec.apiKeyEnv !== undefined &&
    ((deps.env[spec.apiKeyEnv] ?? '') !== '' ||
      (deps.savedAgentKeys[spec.apiKeyEnv] ?? '') !== '');
  const binary = deps.which(spec.binary);
  if (binary === null) {
    return {
      ...base,
      installed: false,
      works: false,
      auth: 'unknown',
      usingApiKey,
      ready: false,
      install: resolveInstallFix(spec, has),
    };
  }
  const version = await deps.run(binary, ['--version'], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (version.status !== 0) {
    const fix = resolveInstallFix(spec, has);
    return {
      ...base,
      installed: true,
      works: false,
      auth: 'unknown',
      usingApiKey,
      ready: false,
      install: { ...fix, label: `Reinstall ${spec.name}` },
      detail: firstLine(version),
    };
  }
  const auth =
    spec.authCheck === undefined
      ? 'unknown'
      : spec.authCheck.parse(
          await deps.run(binary, spec.authCheck.args, {
            timeoutMs: PROBE_TIMEOUT_MS,
          })
        );
  const signIn =
    spec.signIn === undefined
      ? undefined
      : { kind: 'run' as const, label: 'Sign in', command: [...spec.signIn] };
  return {
    ...base,
    installed: true,
    works: true,
    auth,
    usingApiKey,
    ready: usingApiKey || auth !== 'signed-out',
    ...(signIn === undefined ? {} : { signIn }),
  };
}

function pickDefault(
  providers: ProviderState[],
  configured: string | undefined
): string | null {
  const configuredState = providers.find((p) => p.id === configured);
  if (configuredState?.ready === true) return configuredState.id;
  return providers.find((p) => p.ready)?.id ?? configuredState?.id ?? 'claude';
}

function agentStep(
  providers: ProviderState[],
  defaultId: string | null
): SetupStep {
  const chosen = providers.find((p) => p.id === defaultId);
  if (!providers.some((p) => p.installed)) {
    const claude = providers.find((p) => p.id === 'claude')!;
    return {
      id: 'agent',
      status: 'missing',
      message: 'Choose an AI agent to do the work.',
      ...(claude.install === undefined ? {} : { fix: claude.install }),
    };
  }
  if (chosen === undefined)
    return {
      id: 'agent',
      status: 'missing',
      message: 'Choose an AI agent to do the work.',
    };
  if (!chosen.installed) {
    return {
      id: 'agent',
      status: 'missing',
      message: `${chosen.name} isn't installed yet.`,
      ...(chosen.install === undefined ? {} : { fix: chosen.install }),
    };
  }
  if (!chosen.works) {
    return {
      id: 'agent',
      status: 'needs-action',
      message: `${chosen.name} is installed but won't start.`,
      ...(chosen.install === undefined ? {} : { fix: chosen.install }),
      ...(chosen.detail === undefined ? {} : { detail: chosen.detail }),
    };
  }
  if (!chosen.ready) {
    return {
      id: 'agent',
      status: 'needs-action',
      message: `${chosen.name} isn't signed in.`,
      ...(chosen.signIn === undefined ? {} : { fix: chosen.signIn }),
    };
  }
  if (chosen.auth === 'unknown' && !chosen.usingApiKey) {
    return {
      id: 'agent',
      status: 'unknown',
      message: `${chosen.name} is installed. Dispatch couldn't check whether it's signed in.`,
    };
  }
  return { id: 'agent', status: 'ok', message: `${chosen.name} is ready.` };
}

/** Checks git, the project folder (when given) and every known agent. Never throws. */
export async function runSetupCheck(
  input: SetupCheckInput,
  deps: SetupCheckDeps
): Promise<SetupReport> {
  const [git, project, providers] = await Promise.all([
    gitStep(deps),
    input.rootDir === undefined
      ? Promise.resolve(null)
      : projectStep(input.rootDir, deps),
    Promise.all(PROVIDERS.map((spec) => providerState(spec, deps))),
  ]);
  const defaultProvider = pickDefault(
    providers,
    providerById(input.defaultExecutor ?? '')?.id
  );
  return {
    steps: [
      git,
      ...(project === null ? [] : [project]),
      agentStep(providers, defaultProvider),
    ],
    providers,
    defaultProvider,
  };
}

/** Real deps: the widened PATH, node's execFile with a timeout (and no daemon secrets), this process's env. */
export function defaultSetupCheckDeps(): SetupCheckDeps {
  const path = widenedPath();
  return {
    path,
    which: (binary) => whichOnPath(binary, path),
    run: (command, args, opts) =>
      new Promise((resolve) => {
        execFile(
          command,
          [...args],
          {
            cwd: opts.cwd,
            timeout: opts.timeoutMs,
            killSignal: 'SIGKILL',
            env: childEnv({ PATH: path }),
            encoding: 'utf8',
          },
          (error, stdout, stderr) => {
            const killed =
              error !== null &&
              (error as NodeJS.ErrnoException & { killed?: boolean }).killed ===
                true;
            resolve({
              status:
                error === null
                  ? 0
                  : typeof error.code === 'number'
                    ? error.code
                    : null,
              stdout,
              stderr,
              ...(killed
                ? { error: `timed out after ${opts.timeoutMs}ms` }
                : error !== null && typeof error.code !== 'number'
                  ? { error: error.message }
                  : {}),
            });
          }
        );
      }),
    env: process.env,
    savedAgentKeys: readAgentKeys(),
  };
}
