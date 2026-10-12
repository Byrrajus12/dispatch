import type {
  AuthState,
  ProbeResult,
  ProviderSpec,
  SetupFix,
} from './types.js';

// `claude auth status` prints JSON with `loggedIn` (verified on Claude Code 2.1.290);
// signed out it still prints it, but exits 1.
function parseClaudeAuth(r: ProbeResult): AuthState {
  if (r.error !== undefined) return 'unknown';
  try {
    const parsed = JSON.parse(r.stdout) as { loggedIn?: unknown };
    if (parsed.loggedIn === true) return 'signed-in';
    if (parsed.loggedIn === false) return 'signed-out';
  } catch {
    // Older CLIs print text; treat as unchecked rather than guessing.
  }
  return 'unknown';
}

// `codex login status` exits 0 when signed in and non-zero when not.
function parseExitCode(r: ProbeResult): AuthState {
  if (r.error !== undefined || r.status === null) return 'unknown';
  return r.status === 0 ? 'signed-in' : 'signed-out';
}

const EXECUTE_ONLY = { execute: true, plan: false, oversee: false } as const;

/** Every agent setup knows how to install and sign in to. Order is display order. */
export const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    blurb: 'Uses your Claude Pro or Max plan.',
    binary: 'claude',
    install: [
      { kind: 'script', url: 'https://claude.ai/install.sh' },
      {
        kind: 'url',
        href: 'https://docs.claude.com/en/docs/claude-code/setup',
      },
    ],
    signIn: ['claude', 'auth', 'login'],
    authCheck: { args: ['auth', 'status', '--json'], parse: parseClaudeAuth },
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    capabilities: { execute: true, plan: true, oversee: true },
  },
  {
    id: 'codex',
    name: 'Codex',
    blurb: 'Uses your ChatGPT plan.',
    binary: 'codex',
    install: [
      { kind: 'brew', formula: 'codex', cask: true },
      { kind: 'npm', pkg: '@openai/codex' },
      {
        kind: 'url',
        href: 'https://github.com/openai/codex#installing-and-running-codex-cli',
      },
    ],
    signIn: ['codex', 'login'],
    authCheck: { args: ['login', 'status'], parse: parseExitCode },
    apiKeyEnv: 'OPENAI_API_KEY',
    capabilities: { execute: true, plan: true, oversee: true },
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    blurb: 'Uses your Google account.',
    binary: 'gemini',
    install: [
      { kind: 'brew', formula: 'gemini-cli' },
      { kind: 'npm', pkg: '@google/gemini-cli' },
      {
        kind: 'url',
        href: 'https://github.com/google-gemini/gemini-cli#quick-install',
      },
    ],
    // First interactive run walks through Google sign-in.
    signIn: ['gemini'],
    apiKeyEnv: 'GEMINI_API_KEY',
    capabilities: EXECUTE_ONLY,
  },
  {
    id: 'cursor-agent',
    name: 'Cursor Agent',
    blurb: 'Uses your Cursor plan.',
    binary: 'cursor-agent',
    install: [
      { kind: 'script', url: 'https://cursor.com/install' },
      { kind: 'url', href: 'https://cursor.com/cli' },
    ],
    signIn: ['cursor-agent', 'login'],
    capabilities: EXECUTE_ONLY,
  },
  {
    id: 'opencode',
    name: 'opencode',
    blurb: 'Works with many model providers.',
    binary: 'opencode',
    install: [
      { kind: 'script', url: 'https://opencode.ai/install' },
      { kind: 'brew', formula: 'opencode' },
      { kind: 'npm', pkg: 'opencode-ai' },
      { kind: 'url', href: 'https://opencode.ai/docs' },
    ],
    signIn: ['opencode', 'auth', 'login'],
    capabilities: EXECUTE_ONLY,
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    blurb: 'Uses your Qwen account.',
    binary: 'qwen',
    install: [
      { kind: 'npm', pkg: '@qwen-code/qwen-code' },
      { kind: 'url', href: 'https://github.com/QwenLM/qwen-code#installation' },
    ],
    signIn: ['qwen'],
    capabilities: EXECUTE_ONLY,
  },
  {
    id: 'crush',
    name: 'Crush',
    blurb: 'Works with many model providers.',
    binary: 'crush',
    install: [
      { kind: 'brew', formula: 'charmbracelet/tap/crush' },
      { kind: 'npm', pkg: '@charmland/crush' },
      {
        kind: 'url',
        href: 'https://github.com/charmbracelet/crush#installation',
      },
    ],
    signIn: ['crush'],
    capabilities: EXECUTE_ONLY,
  },
  {
    id: 'goose',
    name: 'Goose',
    blurb: 'Works with many model providers.',
    binary: 'goose',
    install: [
      {
        kind: 'url',
        href: 'https://block.github.io/goose/docs/getting-started/installation',
      },
    ],
    signIn: ['goose', 'configure'],
    capabilities: EXECUTE_ONLY,
  },
  {
    id: 'aider',
    name: 'Aider',
    blurb: 'Uses your own API key.',
    binary: 'aider',
    install: [{ kind: 'url', href: 'https://aider.chat/docs/install.html' }],
    capabilities: EXECUTE_ONLY,
  },
];

export function providerById(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function providerForBinary(binary: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.binary === binary);
}

// The first install method this machine can run, as a button. `has` answers
// "is this binary on PATH"; a url method always works, so it is the fallback.
export function resolveInstallFix(
  spec: ProviderSpec,
  has: (binary: string) => boolean
): SetupFix {
  const label = `Install ${spec.name}`;
  for (const method of spec.install) {
    if (method.kind === 'script' && has('curl') && has('bash')) {
      return {
        kind: 'run',
        label,
        command: ['bash', '-c', `curl -fsSL ${method.url} | bash`],
      };
    }
    if (method.kind === 'brew' && has('brew')) {
      return {
        kind: 'run',
        label,
        command: [
          'brew',
          'install',
          ...(method.cask === true ? ['--cask'] : []),
          method.formula,
        ],
      };
    }
    if (method.kind === 'npm' && has('npm')) {
      return {
        kind: 'run',
        label,
        command: ['npm', 'install', '-g', method.pkg],
      };
    }
    if (method.kind === 'url')
      return { kind: 'open-url', label, href: method.href };
  }
  return { kind: 'open-url', label, href: 'https://dispatch.foo/docs' };
}
