import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GitRepo,
  INVALID_REF_ERROR,
  PATH_ESCAPE_ERROR,
} from '../src/git/commands.js';
import type { CommandRunner } from '../src/orchestrator/pr.js';

// Fixture setup only (GitRepo itself is exercised via its own async methods
// below) — throws on failure so a broken fixture fails loudly.
function setupGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.toString()}`
    );
  }
}

let root: string;
let repo: GitRepo;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-gitrepo-'));
  setupGit(root, ['init', '-b', 'main']);
  setupGit(root, ['config', 'user.email', 'test@example.com']);
  setupGit(root, ['config', 'user.name', 'Test']);
  repo = new GitRepo(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('GitRepo: status -> stage -> commit -> log', () => {
  it('drives a file from untracked through a committed log entry', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello\n');

    const untracked = await repo.status();
    if (!untracked.ok) throw new Error(untracked.stderr);
    expect(untracked.branch).toBe('main');
    expect(untracked.untracked).toEqual(['a.txt']);
    expect(untracked.staged).toEqual([]);

    const staged = await repo.stage(['a.txt']);
    expect(staged.ok).toBe(true);

    const afterStage = await repo.status();
    if (!afterStage.ok) throw new Error(afterStage.stderr);
    expect(afterStage.staged).toEqual([{ path: 'a.txt', status: 'A' }]);
    expect(afterStage.untracked).toEqual([]);

    const committed = await repo.commit({ message: 'feat: add a.txt' });
    if (!committed.ok) throw new Error(committed.stderr);
    expect(committed.sha).toMatch(/^[0-9a-f]{40}$/);

    const clean = await repo.status();
    if (!clean.ok) throw new Error(clean.stderr);
    expect(clean.staged).toEqual([]);
    expect(clean.unstaged).toEqual([]);
    expect(clean.untracked).toEqual([]);

    const log = await repo.log();
    if (!log.ok) throw new Error(log.stderr);
    expect(log.commits).toHaveLength(1);
    expect(log.commits[0].subject).toBe('feat: add a.txt');
    expect(log.commits[0].sha).toBe(committed.sha);
    expect(log.commits[0].parents).toEqual([]);
  });
});

describe('GitRepo: discard', () => {
  it('discard removes an untracked file entirely', async () => {
    writeFileSync(join(root, 'scratch.txt'), 'temp\n');

    const result = await repo.discard(['scratch.txt'], true);
    expect(result.ok).toBe(true);

    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.untracked).toEqual([]);
  });

  it('discard reverts a tracked file to its last committed content', async () => {
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    await repo.stage(['a.txt']);
    await repo.commit({ message: 'chore: seed a.txt' });
    writeFileSync(join(root, 'a.txt'), 'v2\n');

    const result = await repo.discard(['a.txt'], true);
    expect(result.ok).toBe(true);

    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.unstaged).toEqual([]);
  });

  it('refuses to run without confirm: true', async () => {
    writeFileSync(join(root, 'scratch.txt'), 'temp\n');

    const result = await repo.discard(['scratch.txt'], false);

    expect(result.ok).toBe(false);
    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.untracked).toEqual(['scratch.txt']);
  });

  it('removes an untracked directory too (clean -d), not just files', async () => {
    mkdirSync(join(root, 'scratch-dir'));
    writeFileSync(join(root, 'scratch-dir', 'nested.txt'), 'temp\n');

    const result = await repo.discard(['scratch-dir'], true);
    expect(result.ok).toBe(true);

    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.untracked).toEqual([]);
  });

  it('does not expand pathspec magic — a literal "*" never wipes the tree', async () => {
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    await repo.stage(['a.txt']);
    await repo.commit({ message: 'chore: seed a.txt' });
    writeFileSync(join(root, 'b.txt'), 'untracked\n');

    const result = await repo.discard(['*'], true);
    expect(result.ok).toBe(true);

    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    // Neither file was touched — `*` was treated as a literal (nonexistent)
    // filename, not a wildcard, thanks to --literal-pathspecs.
    expect(status.untracked).toEqual(['b.txt']);
  });

  it('does not over-reject a real filename that merely starts with ".."', async () => {
    writeFileSync(join(root, '..foo.txt'), 'v1\n');

    const result = await repo.discard(['..foo.txt'], true);

    expect(result.ok).toBe(true);
    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.untracked).toEqual([]);
  });
});

describe('GitRepo: diff', () => {
  it('shows a staged patch, distinct from an empty unstaged diff', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello\n');
    await repo.stage(['a.txt']);

    const staged = await repo.diff({ staged: true });
    if (!staged.ok) throw new Error(staged.stderr);
    expect(staged.patch).toContain('a.txt');
    expect(staged.patch).toContain('+hello');

    const unstaged = await repo.diff({ staged: false });
    if (!unstaged.ok) throw new Error(unstaged.stderr);
    expect(unstaged.patch).toBe('');
  });
});

describe('GitRepo: never throws on a failing git command', () => {
  it('returns ok:false for a commit with nothing staged', async () => {
    const result = await repo.commit({ message: 'nothing to commit' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe('GitRepo: path and ref safety', () => {
  it('rejects a path that escapes the repo root without invoking git', async () => {
    let called = false;
    const fakeRun: CommandRunner = () => {
      called = true;
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    };
    const unsafeRepo = new GitRepo('/tmp/some-repo', fakeRun);

    const result = await unsafeRepo.stage(['../../etc/passwd']);

    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('rejects a path through an in-repo symlink pointing outside the repo root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dispatch-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'do not touch\n');
    symlinkSync(outside, join(root, 'escape-link'));

    let called = false;
    const fakeRun: CommandRunner = () => {
      called = true;
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    };
    const guardedRepo = new GitRepo(root, fakeRun);

    const result = await guardedRepo.stage(['escape-link/secret.txt']);

    expect(result.ok).toBe(false);
    expect(called).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a nonexistent leaf under a symlinked directory pointing outside the repo', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dispatch-outside-'));
    symlinkSync(outside, join(root, 'escape-dir'));

    let called = false;
    const fakeRun: CommandRunner = () => {
      called = true;
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    };
    const guardedRepo = new GitRepo(root, fakeRun);

    // The leaf doesn't exist yet — only the symlinked parent has to resolve.
    const result = await guardedRepo.stage(['escape-dir/newfile.txt']);

    expect(result.ok).toBe(false);
    expect(called).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('allows staging a tracked symlink whose own target lives outside the repo', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dispatch-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'do not touch\n');
    // The symlink *file* sits inside the repo — only what it points to is
    // outside. `git add` on the link itself is a normal, supported op.
    symlinkSync(join(outside, 'secret.txt'), join(root, 'escape-file'));

    const result = await repo.stage(['escape-file']);

    expect(result.ok).toBe(true);
    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.staged).toEqual([{ path: 'escape-file', status: 'A' }]);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('GitRepo: commit sha resolution', () => {
  it('reports ok:false rather than an empty sha when rev-parse fails after a successful commit', async () => {
    const fakeRun: CommandRunner = (_cwd, cmd) => {
      if (cmd.includes('commit'))
        return Promise.resolve({ ok: true, stdout: '', stderr: '' });
      if (cmd.includes('rev-parse')) {
        return Promise.resolve({
          ok: false,
          stdout: '',
          stderr: 'fatal: ambiguous HEAD',
        });
      }
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    };
    const fakeRepo = new GitRepo(root, fakeRun);

    const result = await fakeRepo.commit({ message: 'feat: x' });

    expect(result.ok).toBe(false);
  });
});

describe('GitRepo: commit scoped to paths', () => {
  it('commits only the named path, leaving an unrelated staged file staged', async () => {
    writeFileSync(join(root, 'target.txt'), 'base\n');
    writeFileSync(join(root, 'other.txt'), 'base\n');
    setupGit(root, ['add', '-A']);
    setupGit(root, ['commit', '-m', 'initial']);
    // Exactly the shape an `interrupted-dirty` run leaves behind: the agent's own
    // work sits staged in the index while the reviewer edits a different file.
    writeFileSync(join(root, 'other.txt'), 'agent work\n');
    setupGit(root, ['add', 'other.txt']);
    writeFileSync(join(root, 'target.txt'), 'reviewer fix\n');
    await repo.stage(['target.txt']);

    const result = await repo.commit({
      message: 'review: edit target.txt',
      paths: ['target.txt'],
    });

    expect(result.ok).toBe(true);
    const shown = await repo.show('HEAD', 'other.txt');
    if (!shown.ok) throw new Error(shown.stderr);
    expect(shown.contents).toBe('base\n');
    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.staged).toEqual([{ path: 'other.txt', status: 'M' }]);
  });

  it('refuses a path that escapes the repository root without invoking git', async () => {
    const calls: string[][] = [];
    const fakeRun: CommandRunner = (_cwd, cmd) => {
      calls.push(cmd);
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    };

    const result = await new GitRepo(root, fakeRun).commit({
      message: 'x',
      paths: ['../outside.txt'],
    });

    expect(result).toEqual({ ok: false, stderr: PATH_ESCAPE_ERROR });
    expect(calls).toEqual([]);
  });
});

describe('GitRepo: index entry capture and restore', () => {
  it('puts a clobbered index entry back exactly as it was', async () => {
    writeFileSync(join(root, 'a.txt'), 'base\n');
    setupGit(root, ['add', 'a.txt']);
    setupGit(root, ['commit', '-m', 'initial']);
    writeFileSync(join(root, 'a.txt'), 'agent staged\n');
    setupGit(root, ['add', 'a.txt']);

    const before = await repo.indexEntry('a.txt');
    if (!before.ok) throw new Error(before.stderr);
    writeFileSync(join(root, 'a.txt'), 'reviewer edit\n');
    await repo.stage(['a.txt']);
    const restored = await repo.restoreIndexEntry('a.txt', before.entry);
    writeFileSync(join(root, 'a.txt'), 'agent staged\n');

    expect(restored.ok).toBe(true);
    const staged = await repo.diff({ staged: true, path: 'a.txt' });
    if (!staged.ok) throw new Error(staged.stderr);
    expect(staged.patch).toContain('+agent staged');
    expect(staged.patch).not.toContain('reviewer edit');
  });

  it('removes the index entry again for a path that was not in the index', async () => {
    writeFileSync(join(root, 'a.txt'), 'base\n');
    setupGit(root, ['add', 'a.txt']);
    setupGit(root, ['commit', '-m', 'initial']);
    writeFileSync(join(root, 'new.txt'), 'brand new\n');

    const before = await repo.indexEntry('new.txt');
    if (!before.ok) throw new Error(before.stderr);
    expect(before.entry).toBe(null);
    await repo.stage(['new.txt']);
    const restored = await repo.restoreIndexEntry('new.txt', before.entry);

    expect(restored.ok).toBe(true);
    const status = await repo.status();
    if (!status.ok) throw new Error(status.stderr);
    expect(status.staged).toEqual([]);
    expect(status.untracked).toEqual(['new.txt']);
  });

  it('refuses a path that escapes the repository root', async () => {
    const result = await repo.indexEntry('../outside.txt');

    expect(result).toEqual({ ok: false, stderr: PATH_ESCAPE_ERROR });
  });
});

describe('GitRepo: show', () => {
  it('reads a file at a ref, not the working tree', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello\n');
    setupGit(root, ['add', 'a.txt']);
    setupGit(root, ['commit', '-m', 'add a']);
    writeFileSync(join(root, 'a.txt'), 'changed\n');

    const result = await repo.show('HEAD', 'a.txt');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.contents).toBe('hello\n');
  });

  it('fails for a path that is not in the ref', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello\n');
    setupGit(root, ['add', 'a.txt']);
    setupGit(root, ['commit', '-m', 'add a']);

    const result = await repo.show('HEAD', 'missing.txt');

    expect(result.ok).toBe(false);
  });

  it('refuses a path that escapes the repository root', async () => {
    const result = await repo.show('HEAD', '../outside.txt');

    expect(result).toEqual({ ok: false, stderr: PATH_ESCAPE_ERROR });
  });

  it('refuses a ref that looks like a flag', async () => {
    const result = await repo.show('--upload-pack=x', 'a.txt');

    expect(result).toEqual({ ok: false, stderr: INVALID_REF_ERROR });
  });
});

// The daemon samples run worktrees that an orphaned agent may still be
// committing in (autoResumeAfterBoot's quiet window, surveyRun, claim
// refresh). `git status` and `git diff` opportunistically rewrite the index
// under `index.lock`, and CI caught the daemon holding that lock at the
// instant the orphan's `git add` needed it. An observer must never take it.
describe('GitRepo.observer', () => {
  it('runs every command with --no-optional-locks', async () => {
    const argv: string[][] = [];
    const fakeRun: CommandRunner = (_cwd, cmd) => {
      argv.push(cmd);
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    };

    await GitRepo.observer(root, fakeRun).status();
    await GitRepo.observer(root, fakeRun).diff();
    await GitRepo.observer(root, fakeRun).log({ limit: 1 });

    expect(argv).toHaveLength(3);
    for (const cmd of argv) {
      expect(cmd.slice(0, 3)).toEqual([
        'git',
        '--no-optional-locks',
        '--literal-pathspecs',
      ]);
    }
  });

  it('is opt-in: a plain GitRepo keeps the default locking behaviour', async () => {
    const argv: string[][] = [];
    const fakeRun: CommandRunner = (_cwd, cmd) => {
      argv.push(cmd);
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    };

    await new GitRepo(root, fakeRun).status();

    expect(argv[0]?.slice(0, 2)).toEqual(['git', '--literal-pathspecs']);
  });
});
