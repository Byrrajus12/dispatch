import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

import { dequotedCommand } from '../floor.js';

/**
 * Why the Overseer must ask before a call, beyond the irreversible floor: it would
 * change Dispatch itself through a side door the approval cards do not see.
 * - `dispatch-cli`: the `dispatch` CLI, which acts with this user's credentials;
 * - `daemon-api`: the daemon's HTTP API, or the file holding its token;
 * - `dispatch-files`: a write into a `.dispatch/` directory;
 * - `outside-checkout`: a Codex request for write access outside the project checkout;
 * - `unreadable`: a Codex command ask with no command Dispatch can read, which
 *   no earlier grant may answer.
 */
export type OverseerHold =
  | 'dispatch-cli'
  | 'daemon-api'
  | 'dispatch-files'
  | 'outside-checkout'
  | 'unreadable';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// `dispatch` as a command: at the start or after a separator, past env
// assignments, prefix programs (`env`, `command`, `sudo`, …) and a runner, as
// a bare name or a path ending in it.
const DISPATCH_CLI =
  /(?:^|[;&|`\n(]|\$\()\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|(?:\S*\/)?(?:sudo|doas|env|exec|command|builtin|nice|nohup|time|xargs|timeout|stdbuf|ionice)(?:\s+-\S+)*|\d[\w.]*)\s+)*(?:(?:bunx|npx|bun\s+x|pnpm(?:\s+exec)?|yarn)\s+)?(?:\S*\/)?dispatch(?=\s|$|[;&|)`])/;

const LOCAL_HOST =
  /(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?\/api\b/;
const HTTP_CLIENT = /\b(?:curl|wget|http|https|xh|nc|fetch)\b/;
// Case-insensitive: on macOS `.DISPATCH/` is the same directory.
const DAEMON_FILE = /\.dispatch\/daemons\//i;
const DISPATCH_DIR = /(?:^|[\s'"=/])\.dispatch\//i;
const SHELL_WRITE =
  /(?:>>?|\b(?:rm|mv|cp|sed\s+-i|perl\s+-pi|tee|truncate|touch|chmod|ln)\b)/;

function commandOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command : null;
}

function pathOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as { file_path?: unknown; notebook_path?: unknown };
  const path = record.file_path ?? record.notebook_path;
  return typeof path === 'string' ? path : null;
}

// The paths a Codex file change writes, as the Codex Overseer reports them.
function pathsOf(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return [];
  const paths = (input as { paths?: unknown }).paths;
  return Array.isArray(paths)
    ? paths.filter((path): path is string => typeof path === 'string')
    : [];
}

// Whether a path, resolved against the checkout, sits inside a `.dispatch` directory.
function inDispatchDir(path: string, rootDir: string): boolean {
  const full = normalize(isAbsolute(path) ? path : resolve(rootDir, path));
  return full.split(sep).some((part) => part.toLowerCase() === '.dispatch');
}

// Whether a path, resolved against the checkout, sits outside it.
function outsideCheckout(path: string, rootDir: string): boolean {
  const rel = relative(rootDir, resolve(rootDir, path));
  return rel.startsWith('..') || isAbsolute(rel);
}

// The write roots a Codex permissions ask requests; null for one it can't
// name as a plain path (a glob, a special root), which is treated as outside.
function permissionWriteRoots(input: unknown): (string | null)[] {
  const permissions = (input as { permissions?: unknown } | null)?.permissions;
  const fileSystem =
    typeof permissions === 'object' && permissions !== null
      ? (permissions as { fileSystem?: unknown }).fileSystem
      : undefined;
  if (typeof fileSystem !== 'object' || fileSystem === null) return [];
  const { write, entries } = fileSystem as {
    write?: unknown;
    entries?: unknown;
  };
  const roots: (string | null)[] = [];
  if (Array.isArray(write)) {
    for (const path of write)
      roots.push(typeof path === 'string' ? path : null);
  }
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const { access, path } = (entry ?? {}) as {
        access?: unknown;
        path?: unknown;
      };
      if (access !== 'write') continue;
      const target = (path ?? {}) as { type?: unknown; path?: unknown };
      roots.push(
        target.type === 'path' && typeof target.path === 'string'
          ? target.path
          : null
      );
    }
  }
  return roots;
}

// The hold a shell command needs, read as written.
function commandHold(command: string): OverseerHold | null {
  if (DISPATCH_CLI.test(command)) return 'dispatch-cli';
  if (DAEMON_FILE.test(command)) return 'daemon-api';
  if (HTTP_CLIENT.test(command) && LOCAL_HOST.test(command)) {
    return 'daemon-api';
  }
  if (DISPATCH_DIR.test(command) && SHELL_WRITE.test(command)) {
    return 'dispatch-files';
  }
  return null;
}

/** The hold one Overseer tool call needs, or null when its normal permission path applies. */
export function overseerHoldFor(
  toolName: string,
  input: unknown,
  rootDir: string
): OverseerHold | null {
  if (toolName === 'codex.fileChange') {
    return pathsOf(input).some((path) => inDispatchDir(path, rootDir))
      ? 'dispatch-files'
      : null;
  }
  if (toolName === 'codex.permissions') {
    const roots = permissionWriteRoots(input);
    if (roots.some((root) => root !== null && inDispatchDir(root, rootDir))) {
      return 'dispatch-files';
    }
    return roots.some((root) => root === null || outsideCheckout(root, rootDir))
      ? 'outside-checkout'
      : null;
  }
  if (EDIT_TOOLS.has(toolName)) {
    const path = pathOf(input);
    return path !== null && inDispatchDir(path, rootDir)
      ? 'dispatch-files'
      : null;
  }
  const command = commandOf(input);
  if (command === null) return null;
  // Quoting can split a name the patterns look for (`"dispatch"`, `.dis""patch/`).
  return commandHold(command) ?? commandHold(dequotedCommand(command));
}
