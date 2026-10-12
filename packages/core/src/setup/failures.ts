import { providerById, providerForBinary, PROVIDERS } from './providers.js';

export interface FailureExplanation {
  reason: string;
  fix: 'setup-agent' | 'setup-git' | 'setup-project' | 'retry';
  providerId?: string;
}

// Sign-in failures as agent CLIs print them; `\b` keeps gh's "not logged into" out.
const AUTH =
  /not logged in\b|please run \/login|invalid api key|authentication_error|oauth token has expired|login required/i;
// Model-provider hosts: a 401 or 429 naming one is the agent's, not GitHub's or an MCP server's.
const PROVIDER_HOST =
  '(?:api\\.anthropic\\.com|api\\.openai\\.com|chatgpt\\.com|generativelanguage\\.googleapis\\.com)';
const PROVIDER_401 = new RegExp(
  `unexpected status 401|401 unauthorized[^\\n]*${PROVIDER_HOST}`,
  'i'
);
// Plan limits as agents report them (Codex's "last status: 429"); GitHub's rate limit is not one.
const LIMIT = new RegExp(
  `usage limit|rate_limit_error|last status: 429|429 too many requests[^\\n]*${PROVIDER_HOST}`,
  'i'
);
// `git worktree add` in a repo with no commit yet: the base branch doesn't exist.
const NO_FIRST_COMMIT =
  /invalid reference: \S+|not a valid object name:? '?HEAD'?|ambiguous argument 'HEAD'|does not have any commits yet/i;

// The agent a spawn failure names: a bare binary (`spawn gemini ENOENT`) or a path
// under a package directory (`.../@openai/codex/vendor/.../codex ENOENT`).
function spawnedProvider(text: string): { id: string; broken: boolean } | null {
  const match = /spawn (\S+) ENOENT/.exec(text);
  if (match === null) return null;
  const target = match[1];
  if (!target.includes('/')) {
    const spec = providerForBinary(target);
    return spec === undefined ? null : { id: spec.id, broken: false };
  }
  const spec = PROVIDERS.find((p) => target.split('/').includes(p.binary));
  return spec === undefined ? null : { id: spec.id, broken: true };
}

/** A plain-English reason and the setup step that fixes it, or null if unrecognised. */
export function explainFailure(
  text: string,
  opts: { providerId?: string } = {}
): FailureExplanation | null {
  const named =
    opts.providerId === undefined ? undefined : providerById(opts.providerId);

  if (/Claude Code CLI not found/.test(text)) {
    return {
      reason: "Claude Code isn't installed, or Dispatch can't find it.",
      fix: 'setup-agent',
      providerId: 'claude',
    };
  }
  if (/spawn git ENOENT/.test(text)) {
    return {
      reason: "Git isn't installed, or Dispatch can't find it.",
      fix: 'setup-git',
    };
  }
  const spawned = spawnedProvider(text);
  if (spawned !== null) {
    const name = providerById(spawned.id)!.name;
    return {
      reason: spawned.broken
        ? `${name} is installed but won't start. Reinstalling it usually fixes this.`
        : `${name} isn't installed, or Dispatch can't find it.`,
      fix: 'setup-agent',
      providerId: spawned.id,
    };
  }
  if (/xcrun: error: invalid active developer path/.test(text)) {
    return { reason: "Git isn't installed on this Mac yet.", fix: 'setup-git' };
  }
  if (
    /Please tell me who you are|unable to auto-detect email address/.test(text)
  ) {
    return {
      reason: 'Git needs your name and email before it can save changes.',
      fix: 'setup-git',
    };
  }
  if (/git worktree add failed/.test(text)) {
    if (NO_FIRST_COMMIT.test(text)) {
      return {
        reason:
          'Your project needs a first saved snapshot before an agent can work on it.',
        fix: 'setup-project',
      };
    }
    return {
      reason:
        "Dispatch couldn't make a working copy of your project for the agent.",
      fix: 'retry',
    };
  }
  if (/not a git repository/i.test(text)) {
    return {
      reason: "This folder isn't set up for version tracking yet.",
      fix: 'setup-project',
    };
  }
  if (LIMIT.test(text)) {
    return {
      reason:
        "You've reached your plan's usage limit. Try again once it resets.",
      fix: 'retry',
      ...(named === undefined ? {} : { providerId: named.id }),
    };
  }
  if (AUTH.test(text) || PROVIDER_401.test(text)) {
    const who = named?.name ?? 'Your AI agent';
    return {
      reason: `${who} needs you to sign in again.`,
      fix: 'setup-agent',
      ...(named === undefined ? {} : { providerId: named.id }),
    };
  }
  return null;
}
