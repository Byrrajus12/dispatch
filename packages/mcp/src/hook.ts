import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  const match = readdirSync(dir).find(
    (f) => f.endsWith(suffix) && !f.endsWith('.wait')
  );
  return match === undefined ? null : join(dir, match);
}

// A hook's stdin as HookInput; no input, or input that is not JSON, reads
// as empty so the hook runs with what the environment says.
function parseInput(rawInput: string): HookInput {
  try {
    const parsed = JSON.parse(rawInput) as unknown;
    if (typeof parsed === 'object' && parsed !== null)
      return parsed as HookInput;
  } catch {
    // Fall through to empty input.
  }
  return {};
}

// The project root and this session's token for a hook invocation, or null
// when the session has not registered here.
function hookSession(
  input: HookInput,
  cwd: string
): { root: string; token: string; file: string } | null {
  const root = projectRoot(
    typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : cwd
  );
  // The hook's session_id first; the MCP server's own key covers a client
  // that gave the hook a new id (Claude Code after /clear).
  const keys = [input.session_id, sessionKey()].filter(
    (k): k is string => typeof k === 'string' && k !== ''
  );
  const file =
    keys.map((k) => findSessionFile(root, k)).find((f) => f !== null) ?? null;
  const credential = file === null ? null : readStoredSession(file);
  return file === null || credential === null
    ? null
    : { root, token: credential.token, file };
}

/** Runs one hook invocation end to end: stdin JSON in, hook JSON out. */
export async function runHook(
  client: HookClient,
  event: string,
  rawInput: string,
  cwd: string
): Promise<string> {
  const input = parseInput(rawInput);
  const session = hookSession(input, cwd);
  if (session === null) return '';
  const items = await fetchUnreadAs(session.root, session.token);
  const output = hookOutput(
    client,
    event,
    input,
    items === null ? null : summarize(items)
  );
  return output === null ? '' : JSON.stringify(output);
}

export interface WaitOptions {
  /** Give up after this long with nothing new. */
  timeoutMs: number;
  /** How often to look at the mailbox. */
  pollMs: number;
}

/** `hook claude wait`: runs in the background after a turn and returns the
 *  line to wake the session with once direct mail arrives that was not
 *  already unread when it started, or null at the timeout. Mail already
 *  unread is not re-announced, so a session that leaves it unread is not
 *  woken over and over for it. */
export async function waitForMail(
  rawInput: string,
  cwd: string,
  opts: WaitOptions
): Promise<string | null> {
  const session = hookSession(parseInput(rawInput), cwd);
  if (session === null) return null;
  // Stop fires after every turn, so a newer wait supersedes this one: it
  // stops at its next look once the claim file names another process.
  const claim = `${session.file}.wait`;
  writeFileSync(claim, String(process.pid), { mode: 0o600 });
  const superseded = (): boolean => {
    try {
      return readFileSync(claim, 'utf8') !== String(process.pid);
    } catch {
      return true;
    }
  };
  const baseline = new Set(
    (await fetchUnreadAs(session.root, session.token))?.map(
      (i) => i.deliveryId
    ) ?? []
  );
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.pollMs));
    if (superseded()) return null;
    const items = await fetchUnreadAs(session.root, session.token);
    if (items === null) continue;
    const fresh = items.filter(
      (i) => i.via === 'direct' && !baseline.has(i.deliveryId)
    );
    if (fresh.length > 0) {
      const line = unreadLine(summarize(items));
      return line === null ? null : `${line} Read it now.`;
    }
  }
  return null;
}

const HOOK_COMMAND = 'npx -y @dispatch-foo/mcp hook';

/** How long one background wait listens; the next turn starts another. */
export const WAIT_TIMEOUT_SEC = 3600;

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
  if (client === 'codex')
    return {
      hooks: {
        UserPromptSubmit: entry('UserPromptSubmit'),
        Stop: entry('Stop'),
      },
    };
  // Claude Code also waits in the background after each turn and wakes an
  // idle session (asyncRewake, exit 2) when mail for it arrives.
  return {
    hooks: {
      UserPromptSubmit: entry('UserPromptSubmit'),
      Stop: [
        {
          hooks: [
            { type: 'command', command: `${HOOK_COMMAND} claude Stop` },
            {
              type: 'command',
              command: `${HOOK_COMMAND} claude wait`,
              asyncRewake: true,
              timeout: WAIT_TIMEOUT_SEC,
              rewakeMessage: 'Dispatch: another agent sent you mail.',
              rewakeSummary: 'Dispatch mail',
            },
          ],
        },
      ],
    },
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
