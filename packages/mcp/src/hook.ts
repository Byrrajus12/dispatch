import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  readStoredSession,
  sessionKey,
  sessionsDir,
  sessionSuffix,
} from './identity.js';
import { projectRoot } from './toolKit.js';
import type { UnreadSummary } from './unread.js';
import { fetchUnreadAs, summarize, unreadLine } from './unread.js';

// `dispatch-mcp hook <client> <event>`: an agent client's hook that tells the
// model about unread mail between tool calls and before it stops. Prints the
// client's hook JSON, or nothing; never fails the hook.

export type HookClient = 'claude' | 'codex' | 'gemini';
export const HOOK_CLIENTS: readonly HookClient[] = [
  'claude',
  'codex',
  'gemini',
];

/** What a client sends a hook on stdin; every field is optional. */
export interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  stop_hook_active?: boolean;
}

// The events after which the model may stop: the hook can keep it going.
const STOP_EVENTS = new Set(['Stop', 'AfterAgent']);

/** The hook's stdout for `event`, or null to print nothing. */
export function hookOutput(
  client: HookClient,
  event: string,
  input: HookInput,
  summary: UnreadSummary | null
): Record<string, unknown> | null {
  const line = unreadLine(summary);
  if (line === null || summary === null) return null;
  if (STOP_EVENTS.has(event)) {
    // Only mail addressed to this session itself is worth another turn, and
    // only once: a client re-running Stop after a block says so.
    if (summary.direct === 0 || input.stop_hook_active === true) return null;
    return {
      decision: client === 'gemini' ? 'deny' : 'block',
      reason: `${line} Read it before you finish.`,
    };
  }
  // The dispatch tools already end their results with the same line.
  if (input.tool_name?.startsWith('mcp__dispatch__') === true) return null;
  return {
    hookSpecificOutput: { hookEventName: event, additionalContext: line },
  };
}

/** The session file of the session whose key is `key`, whatever its client. */
export function findSessionFile(root: string, key: string): string | null {
  const dir = sessionsDir(root);
  if (!existsSync(dir)) return null;
  const suffix = `-${sessionSuffix(key)}.json`;
  const match = readdirSync(dir).find((f) => f.endsWith(suffix));
  return match === undefined ? null : join(dir, match);
}

/** Runs one hook invocation end to end: stdin JSON in, hook JSON out. */
export async function runHook(
  client: HookClient,
  event: string,
  rawInput: string,
  cwd: string
): Promise<string> {
  let input: HookInput = {};
  try {
    const parsed = JSON.parse(rawInput) as unknown;
    if (typeof parsed === 'object' && parsed !== null)
      input = parsed as HookInput;
  } catch {
    // No input, or not JSON: run with what the environment says.
  }
  const root = projectRoot(
    typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : cwd
  );
  const key =
    typeof input.session_id === 'string' && input.session_id !== ''
      ? input.session_id
      : sessionKey();
  const file = findSessionFile(root, key);
  const credential = file === null ? null : readStoredSession(file);
  if (credential === null) return '';
  const items = await fetchUnreadAs(root, credential.token);
  const output = hookOutput(
    client,
    event,
    input,
    items === null ? null : summarize(items)
  );
  return output === null ? '' : JSON.stringify(output);
}

const HOOK_COMMAND = 'npx -y @dispatch-foo/mcp hook';

/** The hook configuration to paste into `client`'s settings. */
export function hookConfig(client: HookClient): Record<string, unknown> {
  const entry = (event: string) => [
    {
      hooks: [
        { type: 'command', command: `${HOOK_COMMAND} ${client} ${event}` },
      ],
    },
  ];
  if (client === 'gemini')
    return {
      hooks: {
        BeforeAgent: entry('BeforeAgent'),
        AfterAgent: entry('AfterAgent'),
      },
    };
  return {
    hooks: { UserPromptSubmit: entry('UserPromptSubmit'), Stop: entry('Stop') },
  };
}

const CONFIG_HOME: Record<HookClient, string> = {
  claude: '.claude/settings.json (or ~/.claude/settings.json)',
  codex: '.codex/hooks.json (or ~/.codex/hooks.json)',
  gemini: '.gemini/settings.json (or ~/.gemini/settings.json)',
};

/** `dispatch-mcp hooks <client>`'s output: where to paste, then what. */
export function hookConfigText(client: HookClient): string {
  return (
    `// Merge into ${CONFIG_HOME[client]}:\n` +
    `${JSON.stringify(hookConfig(client), null, 2)}\n`
  );
}
