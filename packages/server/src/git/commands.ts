import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import type { CommandResult, CommandRunner } from '../orchestrator/pr.js';
import { defaultCommandRunner } from '../orchestrator/pr.js';
import { LOG_FORMAT, parseLogLines, parsePorcelainV2 } from './parse.js';
import type { GitLogEntry, GitStatus } from './parse.js';

// Every read/mutation below resolves to this instead of throwing on a
// non-zero git exit; `T` carries whatever extra fields a success returns.
export type GitOutcome<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; stderr: string };

// Pre-flight rejections: git never ran. Exported so tests can tell them apart.
export const PATH_ESCAPE_ERROR = 'path escapes the repository root';
export const INVALID_REF_ERROR = 'invalid ref: must not start with "-"';
// Prefix only — marks a commit that landed but whose sha couldn't be confirmed.
const COMMIT_SHA_UNRESOLVED_PREFIX =
  'commit succeeded but could not resolve its sha: ';

/** One path's index entry: the file mode and blob sha git has staged for it. */
export interface GitIndexEntry {
  mode: string;
  sha: string;
}

// Falls back to the plain path when there's nothing on disk to resolve
// (e.g. a deleted parent, or the repo root itself).
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// Resolves symlinks in every segment but the last, so a symlinked directory
// can't smuggle a path outside the root while the leaf itself (a symlink
// file, or a path that doesn't exist yet) is left alone. Shared by
// GitRepo.safePath and resolveWorktreePath below — one boundary check, not
// two independently-maintained copies.
function resolveRealParent(path: string): string {
  return join(realOrSelf(dirname(path)), basename(path));
}

/**
 * Resolves `rawPath` against `root`, following symlinks in every parent
 * directory the same way GitRepo's pathspec guard does, and returns the real
 * absolute path — or null if it escapes `root`.
 *
 * Routes that touch the worktree with fs.readFileSync/writeFileSync directly
 * (bypassing GitRepo, which runs this same check on every pathspec before
 * calling git) need this instead of a plain string check: a worktree can
 * contain a committed symlinked directory pointing outside itself, and a
 * pure `.split('/').includes('..')` test never sees that redirect.
 *
 * Module-local: callers outside this file want `resolveWorktreeFilePath`, which
 * also rejects a symlinked leaf. Exporting only the strict form keeps a caller
 * from reaching for the weaker one by accident.
 */
function resolveWorktreePath(root: string, rawPath: string): string | null {
  return resolveUnderRealRoot(realOrSelf(resolve(root)), rawPath);
}

// The boundary check itself, taking a root that is already absolute and
// symlink-resolved. Split out so a caller holding a memoized real root (see
// GitRepo.realRoot) isn't forced to realpath it again on every path it checks.
function resolveUnderRealRoot(
  realRoot: string,
  rawPath: string
): string | null {
  if (rawPath === '' || rawPath.startsWith('-')) return null;
  const resolved = resolveRealParent(resolve(realRoot, rawPath));
  const rel = relative(realRoot, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return resolved;
}

/**
 * Like resolveWorktreePath, but additionally rejects a leaf that is itself a
 * symlink, instead of leaving it unresolved. `GitRepo` deliberately leaves
 * the leaf alone (git treats a symlink as an ordinary blob, and `git add`
 * never follows it), but `fs.readFileSync`/`fs.writeFileSync` do follow it —
 * so a worktree file committed as `evil.txt -> /outside/secret.txt` would
 * pass resolveWorktreePath and then read or write straight through to the
 * external target. Only routes that touch the filesystem directly (not
 * through GitRepo) need this stricter form.
 *
 * Rejects a symlink leaf outright rather than resolving and re-checking its
 * target, at the cost of refusing the rarer legitimate case of a symlink
 * pointing back inside the worktree. It does not close the window between this
 * check and the read/write itself — the caller's own content precondition (see
 * api.ts's `baseSha` re-check) is what catches a swap in that gap.
 */
export function resolveWorktreeFilePath(
  root: string,
  rawPath: string
): string | null {
  const resolved = resolveWorktreePath(root, rawPath);
  if (resolved === null) return null;
  try {
    if (lstatSync(resolved).isSymbolicLink()) return null;
  } catch {
    // Nothing on disk yet (a new file) — there's no symlink to reject.
  }
  return resolved;
}

// Prefers stderr, falling back to stdout — git prints some failures
// (e.g. "nothing to commit") to stdout instead.
function commandErrorText(result: CommandResult): string {
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? stderr : result.stdout.trim();
}

// Refuses a ref/branch/commit argument starting with '-' — git would
// otherwise parse it as a flag (e.g. `--upload-pack=...`).
function isSafeRef(name: string): boolean {
  return name.trim() !== '' && !name.startsWith('-');
}

// The git reads and writes the daemon needs, via the injected `CommandRunner`
// — distinct from `WorktreeManager`'s dispatch-worktree lifecycle.
export class GitRepo {
  constructor(
    private readonly cwd: string,
    private readonly run: CommandRunner = defaultCommandRunner
  ) {}

  /**
   * A GitRepo for a checkout some OTHER process may be writing to — a run
   * worktree whose orphaned agent is still committing while the daemon
   * samples it. Every command runs with `--no-optional-locks`, so `git
   * status` and `git diff` skip the opportunistic index refresh they would
   * otherwise do under `index.lock`. Without it the daemon's read can hold
   * that lock at the instant the agent's own `git add` needs it, and the
   * agent's commit fails with "index.lock: File exists" — the daemon looking
   * at a worktree must never be the reason work in it is lost.
   */
  static observer(
    cwd: string,
    run: CommandRunner = defaultCommandRunner
  ): GitRepo {
    const repo = new GitRepo(cwd, run);
    repo.optionalLocks = false;
    return repo;
  }

  private optionalLocks = true;

  // `--literal-pathspecs` disables git's pathspec magic, so a caller-supplied
  // path is always a literal file, never a pattern like `*`.
  private async runGit(args: string[]): Promise<CommandResult> {
    return this.run(this.cwd, [
      'git',
      ...(this.optionalLocks ? [] : ['--no-optional-locks']),
      '--literal-pathspecs',
      ...args,
    ]);
  }

  private realRootCache: string | undefined;

  // Memoized: `this.cwd` never changes, so a batch of paths shouldn't repeat
  // the same realpath syscall once per entry.
  private realRoot(): string {
    this.realRootCache ??= realOrSelf(resolve(this.cwd));
    return this.realRootCache;
  }

  // Refuses a path outside the repo root or starting with '-'; returns the
  // original relative string so git resolves it the same way. Delegates its
  // boundary check to resolveWorktreePath's underlying logic so there is one
  // definition of "escapes the root," shared with direct-fs routes in api.ts.
  private safePath(rawPath: string): string | null {
    return resolveUnderRealRoot(this.realRoot(), rawPath) === null
      ? null
      : rawPath;
  }

  private safePaths(paths: string[]): string[] | null {
    const safe: string[] = [];
    for (const path of paths) {
      const checked = this.safePath(path);
      if (checked === null) return null;
      safe.push(checked);
    }
    return safe;
  }

  // `-z` NUL-delimits every record, so a path containing a literal newline
  // can't be mistaken for a record boundary — see parsePorcelainV2.
  async status(): Promise<GitOutcome<GitStatus>> {
    const result = await this.runGit([
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all',
      '-z',
    ]);
    if (!result.ok) return { ok: false, stderr: commandErrorText(result) };
    return { ok: true, ...parsePorcelainV2(result.stdout) };
  }

  async log(
    opts: { ref?: string; limit?: number; skip?: number } = {}
  ): Promise<GitOutcome<{ commits: GitLogEntry[] }>> {
    if (opts.ref !== undefined && !isSafeRef(opts.ref)) {
      return { ok: false, stderr: INVALID_REF_ERROR };
    }
    const args = [
      'log',
      `--format=${LOG_FORMAT}`,
      '-n',
      String(opts.limit ?? 50),
    ];
    if (opts.skip !== undefined) args.push(`--skip=${opts.skip}`);
    if (opts.ref !== undefined) args.push(opts.ref);
    const result = await this.runGit(args);
    if (!result.ok) return { ok: false, stderr: commandErrorText(result) };
    return { ok: true, commits: parseLogLines(result.stdout) };
  }

  async diff(
    opts: { staged?: boolean; path?: string } = {}
  ): Promise<GitOutcome<{ patch: string }>> {
    const args = ['diff'];
    if (opts.staged === true) args.push('--cached');
    if (opts.path !== undefined) {
      const safePath = this.safePath(opts.path);
      if (safePath === null) return { ok: false, stderr: PATH_ESCAPE_ERROR };
      args.push('--', safePath);
    }
    const result = await this.runGit(args);
    if (!result.ok) return { ok: false, stderr: commandErrorText(result) };
    return { ok: true, patch: result.stdout };
  }

  // One file's contents at a ref — the sides of a diff a patch alone doesn't
  // carry. `--` ends the ref:path spec so nothing after it parses as a flag.
  async show(
    ref: string,
    path: string
  ): Promise<GitOutcome<{ contents: string }>> {
    if (!isSafeRef(ref)) return { ok: false, stderr: INVALID_REF_ERROR };
    const safe = this.safePath(path);
    if (safe === null) return { ok: false, stderr: PATH_ESCAPE_ERROR };
    const result = await this.runGit(['show', `${ref}:${safe}`, '--']);
    if (!result.ok) return { ok: false, stderr: commandErrorText(result) };
    return { ok: true, contents: result.stdout };
  }

  async stage(paths: string[]): Promise<GitOutcome> {
    const safe = this.safePaths(paths);
    if (safe === null) return { ok: false, stderr: PATH_ESCAPE_ERROR };
    const result = await this.runGit(['add', '--', ...safe]);
    return result.ok
      ? { ok: true }
      : { ok: false, stderr: commandErrorText(result) };
  }

  // What the index currently holds for one path, or null when the path has no
  // index entry at all. Paired with restoreIndexEntry so a caller that stages
  // over someone else's staged blob can put the original back — `unstage` can't,
  // since it resets the entry to HEAD rather than to what was there.
  async indexEntry(
    path: string
  ): Promise<GitOutcome<{ entry: GitIndexEntry | null }>> {
    const safe = this.safePath(path);
    if (safe === null) return { ok: false, stderr: PATH_ESCAPE_ERROR };
    const result = await this.runGit(['ls-files', '--stage', '-z', '--', safe]);
    if (!result.ok) return { ok: false, stderr: commandErrorText(result) };
    // `<mode> <sha> <stage>\t<path>`, NUL-terminated per record.
    const record = result.stdout.split('\0').find((r) => r !== '');
    if (record === undefined) return { ok: true, entry: null };
    const [mode, sha] = record.split('\t')[0]?.split(' ') ?? [];
    if (mode === undefined || sha === undefined) {
      return { ok: false, stderr: `unparsable index entry: ${record}` };
    }
    return { ok: true, entry: { mode, sha } };
  }

  // Puts `path`'s index entry back to `entry`, or removes it when `entry` is
  // null (the path was untracked before). Leaves the working tree alone.
  async restoreIndexEntry(
    path: string,
    entry: GitIndexEntry | null
  ): Promise<GitOutcome> {
    const safe = this.safePath(path);
    if (safe === null) return { ok: false, stderr: PATH_ESCAPE_ERROR };
    const result = await this.runGit(
      entry === null
        ? ['update-index', '--force-remove', '--', safe]
        : [
            'update-index',
            '--add',
            '--cacheinfo',
            `${entry.mode},${entry.sha},${safe}`,
          ]
    );
    return result.ok
      ? { ok: true }
      : { ok: false, stderr: commandErrorText(result) };
  }

  // `amend` takes no `confirm`, unlike discard/stashDrop/`branch -D`: it rewrites
  // HEAD but destroys nothing, leaving the replaced commit at HEAD@{1} in the reflog.
  //
  // `paths` scopes the commit to those pathspecs, so whatever else the index
  // happens to hold stays staged instead of riding along — a reviewer edit must
  // not carry the agent's unrelated staged work (see api.ts writeAndCommit).
  async commit(opts: {
    message: string;
    amend?: boolean;
    paths?: string[];
  }): Promise<GitOutcome<{ sha: string }>> {
    const safe =
      opts.paths === undefined ? undefined : this.safePaths(opts.paths);
    if (safe === null) return { ok: false, stderr: PATH_ESCAPE_ERROR };
    const args = ['commit'];
    if (opts.amend === true) args.push('--amend');
    args.push('-m', opts.message);
    if (safe !== undefined) args.push('--', ...safe);
    const result = await this.runGit(args);
    if (!result.ok) return { ok: false, stderr: commandErrorText(result) };
    const head = await this.runGit(['rev-parse', 'HEAD']);
    if (!head.ok) {
      return {
        ok: false,
        stderr: `${COMMIT_SHA_UNRESOLVED_PREFIX}${commandErrorText(head)}`,
      };
    }
    return { ok: true, sha: head.stdout.trim() };
  }
}
