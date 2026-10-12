import { providerById, providerForBinary, PROVIDERS } from './providers.js';

export interface FailureExplanation {
  reason: string;
  fix: 'setup-agent' | 'setup-git' | 'setup-project' | 'retry';
  providerId?: string;
}

const AUTH =
  /not logged in|please run \/login|invalid api key|authentication_error|oauth token has expired|login required|unauthorized/i;
const LIMIT = /usage limit|rate limit|429 too many/i;

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
    if (/invalid reference|not a valid object name|HEAD/.test(text)) {
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
  if (AUTH.test(text)) {
    const who = named?.name ?? 'Your AI agent';
    return {
      reason: `${who} needs you to sign in again.`,
      fix: 'setup-agent',
      ...(named === undefined ? {} : { providerId: named.id }),
    };
  }
  return null;
}
