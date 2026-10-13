// Pure parsers for git plumbing output — no spawning, testable via fixtures.
// `*_FORMAT` pins the field order commands.ts and these parsers share.

interface FileChange {
  path: string;
  /** Git's single-letter status code for this side (M/A/D/R/C/T/U). */
  status: string;
  /** Set only for a rename/copy — the path this entry was renamed/copied from. */
  origPath?: string;
}

export interface GitStatus {
  /** Null on a detached HEAD. */
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: string[];
  conflicted: string[];
}

// Records one staged/unstaged side of a porcelain v2 change line, skipping a
// side whose code is '.' (git's "no change on this side" marker).
function applyChange(
  status: GitStatus,
  indexCode: string,
  worktreeCode: string,
  path: string,
  origPath?: string
): void {
  if (indexCode !== '.') {
    status.staged.push(
      origPath !== undefined
        ? { path, status: indexCode, origPath }
        : { path, status: indexCode }
    );
  }
  if (worktreeCode !== '.') {
    status.unstaged.push(
      origPath !== undefined
        ? { path, status: worktreeCode, origPath }
        : { path, status: worktreeCode }
    );
  }
}

// Parses `git status --porcelain=v2`'s `-z` form, so an embedded newline
// in a path can't be mistaken for a record boundary.
export function parsePorcelainV2(output: string): GitStatus {
  const status: GitStatus = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };

  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i];
    if (record === '') continue;
    if (record.startsWith('# branch.head ')) {
      const head = record.slice('# branch.head '.length).trim();
      status.branch = head === '(detached)' ? null : head;
      continue;
    }
    if (record.startsWith('# branch.upstream ')) {
      status.upstream = record.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match !== null) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
      continue;
    }
    if (record.startsWith('#')) continue; // branch.oid or any other header

    const kind = record[0];
    if (kind === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const fields = record.split(' ');
      const xy = fields[1] ?? '..';
      const path = fields.slice(8).join(' ');
      applyChange(status, xy[0] ?? '.', xy[1] ?? '.', path);
    } else if (kind === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>, origPath is
      // the NEXT token entirely under -z (consumed here, hence `i++`).
      const fields = record.split(' ');
      const xy = fields[1] ?? '..';
      const path = fields.slice(9).join(' ');
      const origPath = tokens[i + 1];
      i++;
      applyChange(status, xy[0] ?? '.', xy[1] ?? '.', path, origPath);
    } else if (kind === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const fields = record.split(' ');
      status.conflicted.push(fields.slice(10).join(' '));
    } else if (kind === '?') {
      status.untracked.push(record.slice(2));
    }
    // '!' (ignored) records are dropped — nothing in GitStatus surfaces them.
  }

  return status;
}

export interface GitLogEntry {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
  parents: string[];
}

// \x1f field separator; %s is one line, so no record separator is needed.
export const LOG_FORMAT = '%H\x1f%h\x1f%s\x1f%an\x1f%aI\x1f%P';

export function parseLogLines(output: string): GitLogEntry[] {
  return output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [sha, shortSha, subject, author, date, parents] =
        line.split('\x1f');
      return {
        sha: sha ?? '',
        shortSha: shortSha ?? '',
        subject: subject ?? '',
        author: author ?? '',
        date: date ?? '',
        parents:
          parents !== undefined && parents.trim() !== ''
            ? parents.trim().split(' ')
            : [],
      };
    });
}
