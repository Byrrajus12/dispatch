import { describe, expect, it } from 'bun:test';

import { explainFailure } from '../src/setup/failures.js';

// Captured from real failures; keep them verbatim when adding cases.
const CASES: [string, string | undefined, ReturnType<typeof explainFailure>][] =
  [
    [
      'Claude Code CLI not found. Install it and re-dispatch — `curl -fsSL https://claude.ai/install.sh | bash`',
      undefined,
      {
        reason: "Claude Code isn't installed, or Dispatch can't find it.",
        fix: 'setup-agent',
        providerId: 'claude',
      },
    ],
    [
      'Error: spawn /Users/x/.nvm/versions/node/v24.3.0/lib/node_modules/@openai/codex/vendor/x86_64-apple-darwin/codex/codex ENOENT',
      undefined,
      {
        reason:
          "Codex is installed but won't start. Reinstalling it usually fixes this.",
        fix: 'setup-agent',
        providerId: 'codex',
      },
    ],
    [
      'spawn gemini ENOENT',
      undefined,
      {
        reason: "Gemini CLI isn't installed, or Dispatch can't find it.",
        fix: 'setup-agent',
        providerId: 'gemini',
      },
    ],
    [
      'Invalid API key · Please run /login',
      'claude',
      {
        reason: 'Claude Code needs you to sign in again.',
        fix: 'setup-agent',
        providerId: 'claude',
      },
    ],
    [
      'Not logged in',
      'codex',
      {
        reason: 'Codex needs you to sign in again.',
        fix: 'setup-agent',
        providerId: 'codex',
      },
    ],
    [
      'fatal: not a git repository (or any of the parent directories): .git',
      undefined,
      {
        reason: "This folder isn't set up for version tracking yet.",
        fix: 'setup-project',
      },
    ],
    [
      'git worktree add failed: fatal: invalid reference: HEAD',
      undefined,
      {
        reason:
          'Your project needs a first saved snapshot before an agent can work on it.',
        fix: 'setup-project',
      },
    ],
    [
      'git worktree add failed: fatal: could not create directory',
      undefined,
      {
        reason:
          "Dispatch couldn't make a working copy of your project for the agent.",
        fix: 'retry',
      },
    ],
    [
      '*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"',
      undefined,
      {
        reason: 'Git needs your name and email before it can save changes.',
        fix: 'setup-git',
      },
    ],
    [
      'xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun',
      undefined,
      { reason: "Git isn't installed on this Mac yet.", fix: 'setup-git' },
    ],
    [
      'Claude AI usage limit reached|1760000000',
      'claude',
      {
        reason:
          "You've reached your plan's usage limit. Try again once it resets.",
        fix: 'retry',
        providerId: 'claude',
      },
    ],
  ];

describe('explainFailure', () => {
  for (const [text, providerId, expected] of CASES) {
    it(`explains: ${text.slice(0, 50)}`, () => {
      expect(
        explainFailure(text, providerId === undefined ? {} : { providerId })
      ).toEqual(expected);
    });
  }

  it('returns null for text it does not recognise', () => {
    expect(explainFailure('TypeError: x is undefined')).toBeNull();
  });
});
