import { childEnv } from '@dispatch-foo/core';
import { constants, realpathSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

import { resolveWorkspacePath } from '../../api/workspacePaths.js';
import { codexDynamicTool } from '../codexDynamicTools.js';
import type { CodexToolHandler } from '../codexDynamicTools.js';
import type { CodexDynamicTool } from '../codexTurn.js';

/**
 * Read-only file tools Dispatch serves to the Codex planner, whose shell is off
 * (Codex has no file tool without one): ClaudePlanner's Read, Grep and Glob, kept
 * inside the checkout. Nothing here writes, and nothing reads `.dispatch` or `.git`.
 */

export const PLANNER_READ_TOOL_NAMES = [
  'read_file',
  'grep',
  'list_files',
] as const;

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_MATCHES = 500;
const MAX_MATCH_CHARS = 500;
const MAX_ENTRIES = 1000;
// How far read_file scans for an offset deep in a huge file before giving up.
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 10_000;
const MAX_STDERR_CHARS = 2000;
const TIMED_OUT_NOTE = '[search timed out; narrow the path or glob]';
// The JS fallback's bounds: entries it visits, the largest file it reads, the walk depth.
const FALLBACK_MAX_FILES = 20_000;
const FALLBACK_MAX_FILE_BYTES = 1024 * 1024;
const FALLBACK_MAX_DEPTH = 24;
const SNIFF_BYTES = 8192;
const CHUNK_BYTES = 64 * 1024;

// Directories none of the tools enter: Dispatch's own state and git internals
// (remote URLs can carry tokens). Compared case-insensitively, as APFS does.
const SEALED = new Set(['.dispatch', '.git']);
const FALLBACK_SKIP = new Set(['node_modules']);

const readArgs = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'File to read, relative to the project root (or absolute inside it).'
    ),
  offset: z
    .number()
    .int()
    .min(1)
    .nullish()
    .describe('1-based line to start from. Defaults to 1.'),
  limit: z
    .number()
    .int()
    .min(1)
    .nullish()
    .describe(`Lines to return, at most ${MAX_LINES} (the default).`),
});

const grepArgs = z.object({
  pattern: z
    .string()
    .min(1)
    .describe(
      'Regular expression (ripgrep syntax) to search file contents for.'
    ),
  path: z
    .string()
    .nullish()
    .describe(
      'File or directory to search, relative to the project root. Defaults to the root.'
    ),
  glob: z
    .string()
    .nullish()
    .describe(
      'Only search files matching this glob, e.g. "**/*.ts" or "src/**".'
    ),
  ignore_case: z.boolean().nullish().describe('Match case-insensitively.'),
});

const listArgs = z.object({
  path: z
    .string()
    .nullish()
    .describe(
      'Directory to list, relative to the project root. Defaults to the root.'
    ),
  glob: z
    .string()
    .nullish()
    .describe(
      'List files under `path` matching this glob, recursively, e.g. "**/*.ts".'
    ),
});

const TOOLS: CodexDynamicTool[] = [
  codexDynamicTool(
    'read_file',
    `Read a text file in the project. Returns numbered lines ("N<TAB>text"), at most ${MAX_LINES} lines or 256KB per call; use offset and limit to page through longer files. Read-only.`,
    readArgs
  ),
  codexDynamicTool(
    'grep',
    `Search file contents in the project for a regular expression. Returns "path:line:text" for up to ${MAX_MATCHES} matching lines, paths relative to the project root. Skips gitignored files. Read-only.`,
    grepArgs
  ),
  codexDynamicTool(
    'list_files',
    `List files in the project. Without a glob, lists the entries of one directory (directories end in "/"). With a glob, lists matching files under the directory recursively, as paths relative to the project root, skipping gitignored files. At most ${MAX_ENTRIES} entries. Read-only.`,
    listArgs
  ),
];

interface ToolResult {
  content: string;
  isError: boolean;
}

const ok = (content: string): ToolResult => ({ content, isError: false });
const fail = (content: string): ToolResult => ({ content, isError: true });

type Located =
  | { ok: true; real: string; rel: string; realRoot: string }
  | { ok: false; message: string };

function isSealedPath(rel: string): boolean {
  return rel
    .split(/[\\/]/)
    .some((segment) => SEALED.has(segment.toLowerCase()));
}

function escapes(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

// Resolves a model-supplied path to its real location inside the checkout: no
// `..` or absolute escape, no symlink leading out, nothing under SEALED.
function locate(rootDir: string, path: string | null | undefined): Located {
  const asked = path === undefined || path === null || path === '' ? '.' : path;
  if (asked.includes('\0')) return { ok: false, message: 'invalid path' };
  const resolved = resolveWorkspacePath(rootDir, { path: asked });
  if (!resolved.ok) {
    return { ok: false, message: `${asked} is outside the project root` };
  }
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync(resolve(rootDir));
  } catch {
    return { ok: false, message: 'the project root is not readable' };
  }
  try {
    real = realpathSync(resolved.path);
  } catch {
    return { ok: false, message: `no such file or directory: ${asked}` };
  }
  const rel = relative(realRoot, real);
  if (escapes(rel)) {
    return { ok: false, message: `${asked} is outside the project root` };
  }
  if (
    isSealedPath(rel) ||
    isSealedPath(relative(resolve(rootDir), resolved.path))
  ) {
    return {
      ok: false,
      message: `${asked} is not readable: .dispatch and .git are off limits`,
    };
  }
  return { ok: true, real, rel: rel === '' ? '.' : rel, realRoot };
}

function clip(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max)} [line truncated]` : line;
}

function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, SNIFF_BYTES);
  for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
  return false;
}

// Opens a file for reading without following a final symlink or blocking on a
// FIFO; the handle's own fstat then decides, so a swap after locate() can't slip in.
async function openRegular(
  file: string
): Promise<{ handle: FileHandle; size: number } | 'directory' | 'other'> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  const info = await handle.stat();
  if (info.isFile()) return { handle, size: info.size };
  await handle.close();
  return info.isDirectory() ? 'directory' : 'other';
}

// Streams the file in chunks, so a huge file costs only the lines asked for;
// stops at `limit` lines or MAX_OUTPUT_BYTES and says where to continue.
async function readLines(
  handle: FileHandle,
  asked: string,
  offset: number,
  limit: number
): Promise<ToolResult> {
  try {
    const decoder = new TextDecoder();
    const buffer = new Uint8Array(CHUNK_BYTES);
    const out: string[] = [];
    let outBytes = 0;
    let pending = '';
    let lineNo = 0;
    let scanned = 0;
    let first = true;
    let stopNote: string | null = null;

    // Takes one complete line; returns false once nothing more is wanted.
    const take = (line: string): boolean => {
      lineNo += 1;
      if (lineNo < offset) return true;
      if (out.length >= limit) {
        stopNote = `[more lines follow; use offset ${lineNo} to continue]`;
        return false;
      }
      const numbered = `${lineNo}\t${clip(line, MAX_LINE_CHARS)}`;
      const bytes = Buffer.byteLength(numbered) + 1;
      if (outBytes + bytes > MAX_OUTPUT_BYTES) {
        stopNote = `[output truncated at 256KB; use offset ${lineNo} to continue]`;
        return false;
      }
      out.push(numbered);
      outBytes += bytes;
      return true;
    };

    reading: for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (first && looksBinary(chunk)) {
        return fail(
          `${asked} looks like a binary file; read_file only reads text`
        );
      }
      first = false;
      scanned += bytesRead;
      const pieces = (pending + decoder.decode(chunk, { stream: true })).split(
        '\n'
      );
      pending = pieces.pop() ?? '';
      // One giant line must not grow without bound; only its head is shown.
      if (pending.length > MAX_LINE_CHARS + 1)
        pending = pending.slice(0, MAX_LINE_CHARS + 1);
      for (const piece of pieces) if (!take(piece)) break reading;
      if (scanned > MAX_SCAN_BYTES) {
        // A wanted line still unfinished at the cap shows its clipped head.
        if (pending !== '' && lineNo + 1 >= offset && !take(pending)) break;
        stopNote = `[stopped after scanning 64MB; use a smaller offset]`;
        break;
      }
    }
    if (stopNote === null) {
      pending += decoder.decode();
      if (pending !== '') take(pending);
    }
    if (out.length === 0 && stopNote === null) {
      return ok(
        lineNo === 0
          ? `${asked} is empty`
          : `${asked} has ${lineNo} lines; offset ${offset} is past the end`
      );
    }
    const body = out.join('\n');
    return ok(stopNote === null ? body : `${body}\n\n${stopNote}`);
  } finally {
    await handle.close();
  }
}

async function readFileTool(
  rootDir: string,
  args: unknown
): Promise<ToolResult> {
  const parsed = readArgs.safeParse(args);
  if (!parsed.success)
    return fail(`invalid read_file arguments: ${parsed.error.message}`);
  const where = locate(rootDir, parsed.data.path);
  if (!where.ok) return fail(where.message);
  const opened = await openRegular(where.real);
  if (opened === 'directory')
    return fail(`${parsed.data.path} is a directory; use list_files`);
  if (opened === 'other')
    return fail(`${parsed.data.path} is not a regular file`);
  return readLines(
    opened.handle,
    parsed.data.path,
    parsed.data.offset ?? 1,
    Math.min(parsed.data.limit ?? MAX_LINES, MAX_LINES)
  );
}

interface RgOutcome {
  lines: string[];
  truncated: boolean;
  timedOut: boolean;
  code: number | null;
  stderr: string;
}

interface SearchScope {
  real: string;
  rel: string;
  realRoot: string;
}

// Drains a stream to its end but keeps only its first `max` characters.
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  max: number
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) {
    if (text.length < max) text += decoder.decode(chunk, { stream: true });
  }
  return text.slice(0, max);
}

// Runs ripgrep with fixed leading options and no config file, reading at most
// `maxLines` lines, killed after SEARCH_TIMEOUT_MS. A directory is searched from
// inside, so globs match relative to it as in the fallback; paths come back
// relative to the project root.
async function runRg(
  rgPath: string,
  args: string[],
  scope: SearchScope,
  maxLines: number
): Promise<RgOutcome> {
  const isDir = (await stat(scope.real)).isDirectory();
  const prefix = isDir && scope.rel !== '.' ? `${scope.rel}/` : '';
  const target = isDir ? '.' : scope.rel;
  const cwd = isDir ? scope.real : scope.realRoot;
  const proc = Bun.spawn(
    [rgPath, '--no-config', '--color=never', ...args, '--', target],
    { cwd, env: childEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, SEARCH_TIMEOUT_MS);
  const stderrText = readCapped(proc.stderr, MAX_STDERR_CHARS);
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let newlines = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      newlines += chunk.split('\n').length - 1;
      text += chunk;
      if (newlines > maxLines || text.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        proc.kill();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const code = await proc.exited;
  clearTimeout(timer);
  const lines = text
    .split('\n')
    .filter((line) => line !== '')
    .slice(0, maxLines)
    .map((line) => prefix + (line.startsWith('./') ? line.slice(2) : line));
  return {
    lines,
    truncated: truncated || newlines > maxLines,
    timedOut,
    code,
    stderr: await stderrText,
  };
}

// Joins result lines, keeping the whole under MAX_OUTPUT_BYTES, with a note
// when the list was cut short.
function listing(lines: string[], truncated: boolean, empty: string): string {
  if (lines.length === 0 && !truncated) return empty;
  const kept: string[] = [];
  let bytes = 0;
  let cut = truncated;
  for (const line of lines) {
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > MAX_OUTPUT_BYTES) {
      cut = true;
      break;
    }
    kept.push(line);
  }
  return cut
    ? `${kept.join('\n')}\n\n[results truncated; narrow the path or glob]`
    : kept.join('\n');
}

const SEALED_GLOBS = ['--iglob=!.dispatch', '--iglob=!.git'];

function rgResult(outcome: RgOutcome, empty: string): ToolResult {
  if (outcome.timedOut) {
    return ok(
      listing(outcome.lines, true, empty).concat(`\n${TIMED_OUT_NOTE}`)
    );
  }
  if (!outcome.truncated && outcome.code === 1) return ok(empty);
  if (!outcome.truncated && outcome.code === 2 && outcome.lines.length === 0) {
    return fail(`search failed: ${outcome.stderr.trim()}`);
  }
  return ok(listing(outcome.lines, outcome.truncated, empty));
}

interface WalkedFile {
  real: string;
  /** Relative to the project root. */
  rel: string;
  /** Relative to the directory the walk started from, for glob matching. */
  local: string;
}

interface Walked {
  files: WalkedFile[];
  truncated: boolean;
  timedOut: boolean;
}

// The fallback's walk: never follows symlinks, never enters SEALED or
// node_modules, and stops at FALLBACK_MAX_FILES entries (directories count) or the deadline.
async function walkFiles(
  start: string,
  realRoot: string,
  glob: string | null | undefined,
  deadline: number
): Promise<Walked> {
  const matcher = glob ? new Bun.Glob(glob) : null;
  const files: WalkedFile[] = [];
  const startInfo = await stat(start);
  if (startInfo.isFile()) {
    return {
      files: [{ real: start, rel: relative(realRoot, start), local: '' }],
      truncated: false,
      timedOut: false,
    };
  }
  const stack: { dir: string; depth: number }[] = [{ dir: start, depth: 0 }];
  let seen = 0;
  const sorted = (): WalkedFile[] =>
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  while (stack.length > 0) {
    if (Date.now() >= deadline) {
      return { files: sorted(), truncated: true, timedOut: true };
    }
    const next = stack.pop();
    if (next === undefined) break;
    let entries: Dirent[];
    try {
      entries = await readdir(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      if (SEALED.has(lower) || FALLBACK_SKIP.has(lower)) continue;
      const full = join(next.dir, entry.name);
      const isDir = entry.isDirectory();
      if (!isDir && !entry.isFile()) continue;
      seen += 1;
      if (seen > FALLBACK_MAX_FILES) {
        return { files: sorted(), truncated: true, timedOut: false };
      }
      if (isDir) {
        if (next.depth < FALLBACK_MAX_DEPTH)
          stack.push({ dir: full, depth: next.depth + 1 });
        continue;
      }
      const local = relative(start, full);
      if (matcher !== null && !matcher.match(local)) continue;
      files.push({ real: full, rel: relative(realRoot, full), local });
    }
  }
  return { files: sorted(), truncated: false, timedOut: false };
}

// One fallback file's text, or null for one it skips: unreadable (EACCES and
// the like), not a regular file, too big, or binary.
async function fallbackText(file: string): Promise<string | null> {
  let opened: Awaited<ReturnType<typeof openRegular>>;
  try {
    opened = await openRegular(file);
  } catch {
    return null;
  }
  if (typeof opened === 'string') return null;
  try {
    if (opened.size > FALLBACK_MAX_FILE_BYTES) return null;
    const bytes = await opened.handle.readFile();
    return looksBinary(bytes) ? null : bytes.toString('utf8');
  } catch {
    return null;
  } finally {
    await opened.handle.close();
  }
}

// Without ripgrep, the pattern is matched as plain text: a JS RegExp can't be
// interrupted, so a catastrophic pattern would stall the daemon.
async function grepFallback(
  where: { real: string; realRoot: string },
  pattern: string,
  glob: string | null | undefined,
  ignoreCase: boolean,
  timeoutMs: number
): Promise<ToolResult> {
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  // One budget for the walk and the reads together.
  const deadline = Date.now() + timeoutMs;
  const walked = await walkFiles(where.real, where.realRoot, glob, deadline);
  const hits: string[] = [];
  let truncated = walked.truncated;
  let timedOut = walked.timedOut;
  for (const file of walked.files) {
    if (Date.now() >= deadline) {
      truncated = true;
      timedOut = true;
      break;
    }
    const text = await fallbackText(file.real);
    if (text === null) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hay = ignoreCase ? line.toLowerCase() : line;
      if (!hay.includes(needle)) continue;
      if (hits.length >= MAX_MATCHES) {
        truncated = true;
        break;
      }
      hits.push(`${file.rel}:${i + 1}:${clip(line, MAX_MATCH_CHARS)}`);
    }
    if (hits.length >= MAX_MATCHES && truncated) break;
  }
  const note =
    '[ripgrep is not installed, so the pattern was matched as plain text]';
  const body = listing(hits, truncated, 'No matches.');
  return ok(`${body}${timedOut ? `\n${TIMED_OUT_NOTE}` : ''}\n${note}`);
}

async function grepTool(
  rootDir: string,
  args: unknown,
  rgPath: string | null,
  timeoutMs: number
): Promise<ToolResult> {
  const parsed = grepArgs.safeParse(args);
  if (!parsed.success)
    return fail(`invalid grep arguments: ${parsed.error.message}`);
  const { pattern, glob } = parsed.data;
  const ignoreCase = parsed.data.ignore_case === true;
  const where = locate(rootDir, parsed.data.path);
  if (!where.ok) return fail(where.message);
  if (rgPath === null) {
    return grepFallback(where, pattern, glob, ignoreCase, timeoutMs);
  }
  // Every model value rides inside its own `--flag=value` token, and the path
  // after `--`, so none can be read as an option (`--pre` would run a program).
  const outcome = await runRg(
    rgPath,
    [
      '--hidden',
      '--line-number',
      '--with-filename',
      '--no-heading',
      `--max-columns=${MAX_MATCH_CHARS}`,
      '--max-columns-preview',
      ...(ignoreCase ? ['--ignore-case'] : []),
      ...(glob ? [`--glob=${glob}`] : []),
      ...SEALED_GLOBS,
      `--regexp=${pattern}`,
    ],
    where,
    MAX_MATCHES
  );
  return rgResult(outcome, 'No matches.');
}

async function listDirectory(
  where: { real: string },
  asked: string
): Promise<ToolResult> {
  const info = await stat(where.real);
  if (!info.isDirectory())
    return fail(`${asked} is not a directory; use read_file`);
  const entries = await readdir(where.real, { withFileTypes: true });
  const names = entries
    .filter((entry) => !SEALED.has(entry.name.toLowerCase()))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
  const truncated = names.length > MAX_ENTRIES;
  return ok(
    listing(names.slice(0, MAX_ENTRIES), truncated, `${asked} is empty`)
  );
}

async function listFilesTool(
  rootDir: string,
  args: unknown,
  rgPath: string | null,
  timeoutMs: number
): Promise<ToolResult> {
  const parsed = listArgs.safeParse(args);
  if (!parsed.success)
    return fail(`invalid list_files arguments: ${parsed.error.message}`);
  const asked = parsed.data.path ?? '.';
  const where = locate(rootDir, asked);
  if (!where.ok) return fail(where.message);
  const glob = parsed.data.glob;
  if (!glob) return listDirectory(where, asked);
  if (rgPath === null) {
    const walked = await walkFiles(
      where.real,
      where.realRoot,
      glob,
      Date.now() + timeoutMs
    );
    const paths = walked.files.map((file) => file.rel);
    const body = listing(
      paths.slice(0, MAX_ENTRIES),
      walked.truncated || paths.length > MAX_ENTRIES,
      'No files matched.'
    );
    return ok(walked.timedOut ? `${body}\n${TIMED_OUT_NOTE}` : body);
  }
  const outcome = await runRg(
    rgPath,
    ['--files', '--hidden', '--sort=path', `--glob=${glob}`, ...SEALED_GLOBS],
    where,
    MAX_ENTRIES
  );
  return rgResult(outcome, 'No files matched.');
}

interface PlannerReadToolOptions {
  /** ripgrep's path, or null for the JS fallback; found on PATH per call by default. */
  rgPath?: string | null;
  /** How long the JS fallback may walk and read; 10s by default. */
  searchTimeoutMs?: number;
}

/** The planner's read-only tools for `rootDir` and the handler that serves them. */
export function plannerReadTools(
  rootDir: string,
  options: PlannerReadToolOptions = {}
): { tools: CodexDynamicTool[]; handler: CodexToolHandler } {
  const rg = (): string | null =>
    options.rgPath !== undefined
      ? options.rgPath
      : Bun.which('rg', { PATH: process.env.PATH ?? '' });
  const timeoutMs = options.searchTimeoutMs ?? SEARCH_TIMEOUT_MS;
  const handler: CodexToolHandler = async (name, args) => {
    try {
      if (name === 'read_file') return await readFileTool(rootDir, args);
      if (name === 'grep')
        return await grepTool(rootDir, args, rg(), timeoutMs);
      if (name === 'list_files')
        return await listFilesTool(rootDir, args, rg(), timeoutMs);
      return fail(`unknown tool: ${name}`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };
  return { tools: TOOLS, handler };
}
