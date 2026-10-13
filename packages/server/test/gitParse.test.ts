import { describe, expect, it } from 'bun:test';

import { parseLogLines, parsePorcelainV2 } from '../src/git/parse.js';

// parsePorcelainV2 takes the `-z` form, so fixtures join records with `\0`.
describe('parsePorcelainV2', () => {
  it('parses staged, unstaged, and both-sides changes on a normal branch', () => {
    const output = [
      '# branch.oid abc123',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 staged.txt',
      '1 .M N... 100644 100644 100644 3333333333333333333333333333333333333333 4444444444444444444444444444444444444444 unstaged.txt',
      '1 MM N... 100644 100644 100644 5555555555555555555555555555555555555555 6666666666666666666666666666666666666666 both.txt',
      '? new-file.txt',
      '! ignored.txt',
    ].join('\0');

    const status = parsePorcelainV2(output);

    expect(status.branch).toBe('main');
    expect(status.upstream).toBe('origin/main');
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(1);
    expect(status.staged).toEqual([
      { path: 'staged.txt', status: 'M' },
      { path: 'both.txt', status: 'M' },
    ]);
    expect(status.unstaged).toEqual([
      { path: 'unstaged.txt', status: 'M' },
      { path: 'both.txt', status: 'M' },
    ]);
    expect(status.untracked).toEqual(['new-file.txt']);
    expect(status.conflicted).toEqual([]);
  });

  it('parses a rename whose origin path is a separate NUL-delimited token', () => {
    const output = [
      '# branch.oid abc123',
      '# branch.head main',
      '2 R. N... 100644 100644 100644 7777777777777777777777777777777777777777 8888888888888888888888888888888888888888 R100 new-name.txt',
      'old-name.txt',
    ].join('\0');

    const status = parsePorcelainV2(output);

    expect(status.staged).toEqual([
      { path: 'new-name.txt', status: 'R', origPath: 'old-name.txt' },
    ]);
    expect(status.unstaged).toEqual([]);
  });

  it('parses a path containing a literal newline without misreading the record boundary', () => {
    const output = [
      '# branch.oid abc123',
      '# branch.head main',
      '1 M. N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 line one\nline two.txt',
    ].join('\0');

    const status = parsePorcelainV2(output);

    expect(status.staged).toEqual([
      { path: 'line one\nline two.txt', status: 'M' },
    ]);
  });

  it('parses an unmerged (conflicted) file as a conflict, not a staged/unstaged change', () => {
    const output = [
      '# branch.oid abc123',
      '# branch.head main',
      'u UU N... 100644 100644 100644 100644 9999999999999999999999999999999999999999 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb conflict.txt',
    ].join('\0');

    const status = parsePorcelainV2(output);

    expect(status.conflicted).toEqual(['conflict.txt']);
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
  });

  it('reports a detached HEAD as a null branch', () => {
    const output = ['# branch.oid abc123', '# branch.head (detached)'].join(
      '\0'
    );

    const status = parsePorcelainV2(output);

    expect(status.branch).toBeNull();
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  it('returns a clean empty status for a fresh repo with no commits', () => {
    const output = ['# branch.oid (initial)', '# branch.head main'].join('\0');

    const status = parsePorcelainV2(output);

    expect(status.branch).toBe('main');
    expect(status.upstream).toBeNull();
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
    expect(status.untracked).toEqual([]);
    expect(status.conflicted).toEqual([]);
  });

  it('returns a sane empty result for a totally empty string', () => {
    const status = parsePorcelainV2('');

    expect(status.branch).toBeNull();
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
    expect(status.untracked).toEqual([]);
    expect(status.conflicted).toEqual([]);
  });
});

describe('parseLogLines', () => {
  it('parses multiple commits including parent shas', () => {
    const output = [
      'aaa\x1faaa1234\x1ffeat: add thing\x1fAlice\x1f2026-01-01T00:00:00-08:00\x1fbbb',
      'bbb\x1fbbb1234\x1ffix: bug\x1fBob\x1f2025-12-31T00:00:00-08:00\x1fccc ddd',
    ].join('\n');

    const commits = parseLogLines(output);

    expect(commits).toEqual([
      {
        sha: 'aaa',
        shortSha: 'aaa1234',
        subject: 'feat: add thing',
        author: 'Alice',
        date: '2026-01-01T00:00:00-08:00',
        parents: ['bbb'],
      },
      {
        sha: 'bbb',
        shortSha: 'bbb1234',
        subject: 'fix: bug',
        author: 'Bob',
        date: '2025-12-31T00:00:00-08:00',
        parents: ['ccc', 'ddd'],
      },
    ]);
  });

  it('parses a root commit (no parents) as an empty parents array', () => {
    const output =
      'ccc\x1fccc1234\x1finitial commit\x1fAlice\x1f2025-01-01T00:00:00Z\x1f';

    const commits = parseLogLines(output);

    expect(commits).toEqual([
      {
        sha: 'ccc',
        shortSha: 'ccc1234',
        subject: 'initial commit',
        author: 'Alice',
        date: '2025-01-01T00:00:00Z',
        parents: [],
      },
    ]);
  });

  it('returns an empty list for a repo with no commits', () => {
    expect(parseLogLines('')).toEqual([]);
  });
});
