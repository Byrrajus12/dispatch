import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

import { dequotedCommand } from '../floor.js';
import {
  commandPositionNames,
  commandTokens,
  globMatches,
  isSimpleCommand,
  programName,
  shellWords,
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
  'nscurl',
  'wget2',
  'lwp-request',
  'get',
  'post',
  'curlie',
  'httpx',
  'xhs',
  'websocat',
  'grpcurl',
  'openssl',
  'osascript',
  'pwsh',
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

// Host names that resolve to a loopback address, or may (wildcard DNS).
const LOOPBACK_NAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'localhost.localdomain',
]);
const LOOPBACK_DOMAIN =
  /(?:^|\.)(?:localhost|lvh\.me|localtest\.me|localh\.st|localho\.st|lacolhost\.com|nip\.io|sslip\.io|xip\.io)$/;

// An IPv4 address the way inet_aton reads it (one to four parts, each
// decimal, octal or hex), as a number; null for anything else.
function inetAton(host: string): number | null {
  const parts = host.split('.');
  if (parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    // Leading zeros never change the value, however many there are.
    const hex = /^0x0*([0-9a-f]{0,8})$/.exec(part);
    const octal = /^0+([0-7]{0,11})$/.exec(part);
    if (hex !== null) values.push(hex[1] === '' ? 0 : parseInt(hex[1], 16));
    else if (octal !== null) {
      values.push(octal[1] === '' ? 0 : parseInt(octal[1], 8));
    } else if (/^[1-9]\d{0,15}$/.test(part)) values.push(Number(part));
    else return null;
  }
  const last = values.pop() ?? 0;
  let value = 0;
  for (const byte of values) {
    if (byte > 255) return null;
    value = value * 256 + byte;
  }
  const room = 256 ** (4 - values.length);
  return last < room ? value * room + last : null;
}

function isLocalV4(host: string): boolean {
  const value = inetAton(host);
  return value !== null && (value === 0 || Math.floor(value / 2 ** 24) === 127);
}

// A loopback or unspecified IPv6 address, an IPv4-mapped one included.
function isLocalV6(host: string): boolean {
  const address = host.replace(/%.*$/, '');
  if (!address.includes(':') || !/^[0-9a-f:.]+$/.test(address)) return false;
  const rest = address.replace(/^[0:]*/, '').replace(/^ffff:/, '');
  return (
    rest === '' ||
    rest === '1' ||
    /^0{0,4}:0{0,4}$/.test(rest) ||
    /^7f[0-9a-f]{2}:/.test(rest) ||
    (rest.includes('.') && isLocalV4(rest))
  );
}

// A loopback or any-address host, in the spellings a URL or curl accepts.
function isLocalHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  return (
    LOOPBACK_NAMES.has(bare) ||
    LOOPBACK_DOMAIN.test(bare) ||
    isLocalV4(bare) ||
    isLocalV6(bare)
  );
}

// One pass of %XX decoding, as curl applies to a URL's host name.
function percentDecoded(text: string): string {
  return text.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

// The host a token names: past a scheme and user, up to a port or path,
// percent-decoded, since curl decodes an encoded host name.
function hostOf(token: string): string {
  return percentDecoded(rawHostOf(token)).toLowerCase();
}

function rawHostOf(token: string): string {
  const rest = token.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close === -1 ? host : host.slice(0, close + 1);
  }
  // Two or more colons in an address of hex digits is bare IPv6, not host:port.
  return host.indexOf(':') !== host.lastIndexOf(':') &&
    /^[0-9a-f:.%]+$/.test(host)
    ? host
    : host.split(':')[0];
}

// Every host a token may name: as a URL, and each colon-separated part, as
// curl's `--resolve host:port:addr` and `--connect-to` spell them.
function hostsIn(token: string): string[] {
  return [
    hostOf(token),
    ...token.split(':').map((part) => hostOf(part.replace(/^\/+/, ''))),
  ];
}

// Options that read the request's URLs from a file, which no reader sees.
const CURL_CONFIG = /^(?:-[a-zA-Z]*K|--config$)/;
const URL_FILE = /^(?:-[a-zA-Z]*i|--input-file$)/;
const URL_FILE_CLIENTS = new Set(['wget', 'wget2', 'aria2c']);
// httpie-style clients read `:4000/x` as localhost.
const HTTPIE_CLIENTS = new Set(['http', 'https', 'xh', 'xhs', 'httpie']);

// Whether an HTTP client in the command may reach a loopback host.
function reachesLoopback(
  tokens: readonly string[],
  programs: readonly string[]
): boolean {
  if (!programs.some((program) => HTTP_CLIENTS.has(program))) return false;
  if (tokens.some((token) => hostsIn(token).some(isLocalHost))) return true;
  if (
    programs.includes('curl') &&
    tokens.some(
      (token, at) =>
        CURL_CONFIG.test(token) ||
        (token === '--url' && tokens[at + 1]?.startsWith('@'))
    )
  ) {
    return true;
  }
  if (
    programs.some((program) => URL_FILE_CLIENTS.has(program)) &&
    tokens.some((token) => URL_FILE.test(token))
  ) {
    return true;
  }
  return (
    programs.some((program) => HTTPIE_CLIENTS.has(program)) &&
    tokens.some((token) => token.startsWith(':'))
  );
}

// Text that hints at what the holds guard: Dispatch, its daemon, a loopback
// host or a glob bracket a hold may misread.
const HELD_TARGET_HINTS = [
  'dispatch',
  'daemon',
  'localhost',
  '127.',
  '::1',
  '0.0.0.0',
  '[',
  'lvh.me',
  'nip.io',
  'sslip.io',
  'xip.io',
  'localtest.me',
  'localh.st',
  'localho.st',
  'lacolhost.com',
  '.local',
  '0x7f',
  '0177',
  '2130706',
];

// Whether a word names a path outside the checkout: under home (`~`), an
// absolute path not under rootDir (`/` included), or a relative one whose `..` climbs out.
// Relative words resolve against `cwd`, where the command runs.
function pathOutside(word: string, rootDir: string, cwd: string): boolean {
  if (word.startsWith('~')) return true;
  if (!word.startsWith('/') && !word.split('/').includes('..')) return false;
  return outsideCheckout(resolve(cwd, word), rootDir);
}

// The paths one argument may name: whole, after an option's `=` or `@`
// (`-d@/x`), glued to a short option (`-f/etc/x`), or as a `file://` URL.
function pathCandidates(word: string): string[] {
  const parts = [
    word,
    ...word.split('=').slice(1),
    ...word.split('@').slice(1),
  ];
  return parts.flatMap((part) => [
    part,
    part.replace(/^-[A-Za-z]+/, ''),
    part.replace(/^file:\/\//i, ''),
  ]);
}

// Whether any argument names a path outside the checkout.
function namesPathOutside(
  command: string,
  rootDir: string,
  cwd: string
): boolean {
  const words = shellWords(command) ?? commandTokens(command);
  return words
    .slice(1)
    .some((word) =>
      pathCandidates(word).some((part) => pathOutside(part, rootDir, cwd))
    );
}

/** Where a command ask runs, resolved against the checkout; the checkout when it names none. */
export function commandCwd(input: unknown, rootDir: string): string {
  const cwd =
    typeof input === 'object' && input !== null
      ? (input as { cwd?: unknown }).cwd
      : undefined;
  return typeof cwd === 'string' && cwd !== ''
    ? resolve(rootDir, cwd)
    : resolve(rootDir);
}

// The hold a working directory needs: inside a `.dispatch` directory, its daemon files included.
function cwdHold(cwd: string): OverseerHold | null {
  const segments = normalize(cwd)
    .split(sep)
    .map((segment) => segment.toLowerCase());
  const at = segments.indexOf('.dispatch');
  if (at === -1) return null;
  return segments[at + 1] === 'daemons' ? 'daemon-api' : 'dispatch-files';
}

/**
 * True when a command, with the project's own path taken out, mentions
 * anything a hold guards, or names a path outside the checkout. The Overseer
 * never answers such a command itself and grants it only by its text, so a
 * gap in a hold costs an ask, not a bypass.
 */
export function hintsAtHeldTarget(
  command: string,
  rootDir?: string,
  cwd?: string
): boolean {
  if (rootDir !== undefined) {
    const where = resolve(rootDir, cwd ?? '.');
    // Running outside the checkout, or inside `.dispatch`, is itself a hint.
    if (outsideCheckout(where, rootDir) || cwdHold(where) !== null) return true;
    if (namesPathOutside(command, rootDir, where)) return true;
  }
  const strip = (text: string): string =>
    rootDir !== undefined && rootDir.length > 1
      ? text.split(rootDir).join('')
      : text;
  const texts = [
    command,
    shellWords(command)?.join(' ') ?? '',
    dequotedCommand(command),
  ].map((text) => strip(text).toLowerCase());
  texts.push(percentDecoded(texts[0]).toLowerCase());
  if (
    texts.some((text) => HELD_TARGET_HINTS.some((hint) => text.includes(hint)))
  ) {
    return true;
  }
  return commandTokens(texts[0]).some(
    (token) => /[:/]/.test(token) && hostsIn(token).some(isLocalHost)
  );
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
  // Paths are read both split at `=` and whole, so `--to=.dispatch/x` and a
  // bracket like `[[=h=]]` are each seen as a path segment.
  const words = dequotedCommand(command).split(/[\s;&|()<>`]+/);
  const paths = [...tokens, ...words].map(dispatchPathIn);
  if (paths.includes('daemon')) return 'daemon-api';
  if (reachesLoopback(tokens, programs)) return 'daemon-api';
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
  // A command run inside `.dispatch` may write there with no path naming it.
  const held = commandHold(command);
  if (held === 'dispatch-cli' || held === 'daemon-api') return held;
  return cwdHold(commandCwd(input, rootDir)) ?? held;
}
