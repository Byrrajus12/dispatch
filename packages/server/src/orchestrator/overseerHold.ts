import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

import {
  commandPositionNames,
  commandTokens,
  globMatches,
  isSimpleCommand,
  programName,
} from './shellCommand.js';

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

const DISPATCH_PROGRAMS = new Set(['dispatch', 'dispatch-cli']);
const HTTP_CLIENTS = new Set([
  'curl',
  'wget',
  'http',
  'https',
  'xh',
  'httpie',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'telnet',
  'fetch',
  'aria2c',
  'node',
  'bun',
  'deno',
  'python',
  'python3',
  'ruby',
  'perl',
  'php',
]);
// Simple commands that only read, so naming a `.dispatch` path is not a write.
const READ_ONLY_PROGRAMS = new Set([
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'grep',
  'rg',
  'ls',
  'wc',
  'file',
  'stat',
  'diff',
  'jq',
  'yq',
  'bat',
]);
// The `.dispatch` paths a token names, and whether one reaches the daemon files.
function dispatchPathIn(token: string): 'daemon' | 'files' | null {
  const segments = token.split('/');
  const at = segments.findIndex((segment) => globMatches(segment, '.dispatch'));
  if (at === -1) return null;
  const next = segments[at + 1];
  return next !== undefined && globMatches(next, 'daemons')
    ? 'daemon'
    : 'files';
}

// A loopback or any-address host, in the spellings a URL or curl accepts.
function isLocalHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  return (
    bare === 'localhost' ||
    bare.endsWith('.localhost') ||
    /^127(?:\.\d{1,10}){0,3}$/.test(bare) ||
    /^0+(?:\.0+){0,3}$/.test(bare) ||
    bare === '::1' ||
    /^(?:0{0,4}:){2,7}0{0,3}1$/.test(bare) ||
    /^::ffff:(?:127\.|7f)/.test(bare) ||
    /^0x7f[0-9a-f]{0,6}$/.test(bare) ||
    /^0+177(?:\.\d{1,10}){0,3}$/.test(bare) ||
    /^21(?:3[0-9]|4[0-7])\d{6}$/.test(bare)
  );
}

// The host a token names: past a scheme and user, up to a port or path.
function hostOf(token: string): string {
  const rest = token.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close === -1 ? host : host.slice(0, close + 1);
  }
  // Two or more colons is a bare IPv6 address, not host:port.
  return host.indexOf(':') !== host.lastIndexOf(':')
    ? host
    : host.split(':')[0];
}

// The hold a shell command needs, from its tokens as the shell spells them.
function commandHold(command: string): OverseerHold | null {
  const tokens = commandTokens(command);
  const programs = tokens.map(programName);
  // Only words the shell may run as a program; a glob counts when it holds a
  // literal letter, since `*` alone matches anything.
  if (
    commandPositionNames(command).some(
      (program) =>
        DISPATCH_PROGRAMS.has(program) ||
        (/[a-z]/.test(program) &&
          [...DISPATCH_PROGRAMS].some((name) => globMatches(program, name)))
    )
  ) {
    return 'dispatch-cli';
  }
  const paths = tokens.map(dispatchPathIn);
  if (paths.includes('daemon')) return 'daemon-api';
  if (
    programs.some((program) => HTTP_CLIENTS.has(program)) &&
    tokens.some((token) => isLocalHost(hostOf(token)))
  ) {
    return 'daemon-api';
  }
  if (paths.includes('files')) {
    const readOnly =
      isSimpleCommand(command) && READ_ONLY_PROGRAMS.has(programs[0] ?? '');
    return readOnly ? null : 'dispatch-files';
  }
  return null;
}

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
  return commandHold(command);
}
