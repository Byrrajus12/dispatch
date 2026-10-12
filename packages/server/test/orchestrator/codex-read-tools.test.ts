import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PLANNER_READ_TOOL_NAMES,
  plannerReadTools,
} from '../../src/orchestrator/planners/codexReadTools.js';

const RG = Bun.which('rg', { PATH: process.env.PATH });

let root = '';
let outside = '';

// A checkout with ordinary sources plus everything the tools must not reach:
// Dispatch's state, git internals, and symlinks that lead out of the root.
beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-read-')));
  root = join(base, 'repo');
  outside = join(base, 'outside');
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  mkdirSync(join(root, '.dispatch'));
  mkdirSync(join(root, '.git'));
  mkdirSync(outside);
  writeFileSync(join(root, 'README.md'), 'hello\nworld\nneedle here\n');
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1; // needle\n');
  writeFileSync(join(root, 'src', 'deep', 'b.ts'), 'const b = "needle";\n');
  writeFileSync(join(root, '.dispatch', 'config.yml'), 'needle: secret\n');
  writeFileSync(join(root, '.git', 'config'), 'needle token\n');
  writeFileSync(join(outside, 'secret.txt'), 'needle outside\n');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'));
  symlinkSync(outside, join(root, 'leak-dir'));
  symlinkSync(join(root, 'README.md'), join(root, 'readme-link.md'));
  writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 0, 2, 3]));
  const many = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(root, 'long.txt'), `${many.join('\n')}\n`);
  writeFileSync(join(root, 'wide.txt'), `${'x'.repeat(5000)}\n`);
});

afterAll(() => {
  rmSync(join(root, '..'), { recursive: true, force: true });
});

async function call(
  name: string,
  args: unknown,
  rgPath: string | null = RG
): Promise<{ content: unknown; isError: boolean }> {
  return plannerReadTools(root, { rgPath }).handler(name, args);
}

describe('plannerReadTools declarations', () => {
  it('declares read_file, grep and list_files with object schemas', () => {
    const { tools } = plannerReadTools(root);
    expect(tools.map((t) => t.name)).toEqual([...PLANNER_READ_TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.type).toBe('function');
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  it('refuses a tool it does not serve', async () => {
    const out = await call('write_file', { path: 'x' });
    expect(out.isError).toBe(true);
  });
});

describe('read_file', () => {
  it('returns the file with line numbers', async () => {
    const out = await call('read_file', { path: 'README.md' });
    expect(out.isError).toBe(false);
    expect(out.content).toBe('1\thello\n2\tworld\n3\tneedle here');
  });

  it('honours offset and limit', async () => {
    const out = await call('read_file', {
      path: 'long.txt',
      offset: 10,
      limit: 2,
    });
    expect(out.content).toContain('10\tline 10\n11\tline 11');
    expect(out.content).not.toContain('line 12\n');
    expect(out.content).toContain('use offset 12');
  });

  it('caps a long file at 2000 lines and a wide line at 2000 characters', async () => {
    const long = (await call('read_file', { path: 'long.txt' }))
      .content as string;
    expect(long).toContain('2000\tline 2000');
    expect(long).not.toContain('line 2001');
    expect(long).toContain('use offset 2001');
    const wide = (await call('read_file', { path: 'wide.txt' }))
      .content as string;
    expect(wide.length).toBeLessThan(2200);
    expect(wide).toContain('[line truncated]');
  });

  it('caps the output at 256KB', async () => {
    const big = join(root, 'big.txt');
    writeFileSync(big, `${Array(2000).fill('y'.repeat(1999)).join('\n')}\n`);
    try {
      const out = (await call('read_file', { path: 'big.txt' }))
        .content as string;
      expect(Buffer.byteLength(out)).toBeLessThanOrEqual(256 * 1024 + 200);
      expect(out).toContain('output truncated at 256KB');
    } finally {
      rmSync(big);
    }
  });

  it('reads an absolute path inside the root and a symlink that stays inside', async () => {
    const abs = await call('read_file', { path: join(root, 'README.md') });
    expect(abs.content).toContain('1\thello');
    const link = await call('read_file', { path: 'readme-link.md' });
    expect(link.content).toContain('1\thello');
  });

  it.each([
    ['a ../ escape', '../outside/secret.txt'],
    ['a nested ../ escape', 'src/../../outside/secret.txt'],
    ['an absolute path outside the root', '/etc/hosts'],
    ['a symlink to a file outside', 'leak.txt'],
    ['a file under a symlinked directory outside', 'leak-dir/secret.txt'],
  ])('refuses %s', async (_label, path) => {
    const out = await call('read_file', { path });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('outside the project');
  });

  it.each([
    '.dispatch/config.yml',
    '.DISPATCH/config.yml',
    '.git/config',
    'src/../.dispatch/config.yml',
  ])('refuses Dispatch state and git internals: %s', async (path) => {
    const out = await call('read_file', { path });
    expect(out.isError).toBe(true);
    expect(String(out.content)).not.toContain('secret');
    expect(String(out.content)).not.toContain('token');
  });

  it('reports a missing file, a directory, a binary file and bad arguments', async () => {
    expect((await call('read_file', { path: 'nope.ts' })).content).toContain(
      'no such file'
    );
    expect((await call('read_file', { path: 'src' })).content).toContain(
      'is a directory'
    );
    expect((await call('read_file', { path: 'bin.dat' })).content).toContain(
      'binary'
    );
    expect((await call('read_file', { path: 7 })).isError).toBe(true);
    expect((await call('read_file', {})).isError).toBe(true);
    expect(
      (await call('read_file', { path: 'README.md', limit: 0 })).isError
    ).toBe(true);
  });
});

// Every search behaviour holds on ripgrep and on the plain-JS fallback.
const engines: [string, string | null][] = [
  ...(RG === null ? [] : [['ripgrep', RG] as [string, string]]),
  ['the JS fallback', null],
];

describe.each(engines)('grep on %s', (_engine, rgPath) => {
  it('finds matches as path:line:text, skipping .dispatch, .git and links out', async () => {
    const out = await call('grep', { pattern: 'needle' }, rgPath);
    expect(out.isError).toBe(false);
    const text = out.content as string;
    expect(text).toContain('README.md:3:needle here');
    expect(text).toContain('src/a.ts:1:');
    expect(text).toContain('src/deep/b.ts:1:');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('token');
    expect(text).not.toContain('outside');
  });

  it('narrows by path and glob', async () => {
    const inSrc = (
      await call('grep', { pattern: 'needle', path: 'src' }, rgPath)
    ).content as string;
    expect(inSrc).toContain('deep/b.ts');
    expect(inSrc).not.toContain('README.md');
    const ts = (
      await call('grep', { pattern: 'needle', glob: '**/*.ts' }, rgPath)
    ).content as string;
    expect(ts).toContain('src/a.ts');
    expect(ts).not.toContain('README.md');
  });

  it('caps matches at 500 lines', async () => {
    const hits = join(root, 'hits.txt');
    writeFileSync(hits, `${Array(1000).fill('needle').join('\n')}\n`);
    try {
      const out = (
        await call('grep', { pattern: 'needle', path: 'hits.txt' }, rgPath)
      ).content as string;
      expect(out.split('\n').filter((l) => l.includes(':needle')).length).toBe(
        500
      );
      expect(out).toContain('results truncated');
    } finally {
      rmSync(hits);
    }
  });

  it('treats a flag-shaped pattern as text, never as an option', async () => {
    const marker = join(root, '..', 'pre-ran');
    const script = join(root, '..', 'pre.sh');
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\ncat "$1"\n`);
    chmodSync(script, 0o755);
    writeFileSync(join(root, 'flags.txt'), `literal -e and --pre=${script}\n`);
    for (const pattern of [`--pre=${script}`, '-e', '--files']) {
      const out = await call('grep', { pattern, path: 'flags.txt' }, rgPath);
      expect(out.isError).toBe(false);
      if (pattern !== '--files')
        expect(out.content as string).toContain('flags.txt:1:');
    }
    const globbed = await call(
      'grep',
      { pattern: 'literal', glob: `--pre=${script}` },
      rgPath
    );
    expect(globbed.isError).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses paths outside the root and Dispatch state', async () => {
    for (const path of ['..', '/etc', 'leak-dir', '.dispatch', '.git']) {
      const out = await call('grep', { pattern: 'needle', path }, rgPath);
      expect(out.isError).toBe(true);
    }
  });
});

describe('grep fallback', () => {
  it('matches the pattern as plain text, so a catastrophic regex cannot hang it', async () => {
    const started = Date.now();
    const out = await call('grep', { pattern: '(a+)+$' }, null);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.isError).toBe(false);
    expect(out.content).toContain('No matches');
    const literal = await call('grep', { pattern: 'needle here' }, null);
    expect(literal.content).toContain('README.md:3:');
  });
});

describe.skipIf(RG === null)('grep on ripgrep', () => {
  it('reports a pattern ripgrep cannot parse', async () => {
    const out = await call('grep', { pattern: '(unclosed' });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('regex');
  });

  it('ignores a ripgrep config file in the environment', async () => {
    const marker = join(root, '..', 'config-pre-ran');
    const script = join(root, '..', 'config-pre.sh');
    const config = join(root, '..', 'ripgrep-config');
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\ncat "$1"\n`);
    chmodSync(script, 0o755);
    writeFileSync(config, `--pre=${script}\n`);
    const previous = process.env.RIPGREP_CONFIG_PATH;
    process.env.RIPGREP_CONFIG_PATH = config;
    try {
      const out = await call('grep', { pattern: 'hello', path: 'README.md' });
      expect(out.content).toContain('README.md:1:hello');
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
      else process.env.RIPGREP_CONFIG_PATH = previous;
    }
  });
});

describe.each(engines)('list_files on %s', (_engine, rgPath) => {
  it('lists a directory without .dispatch or .git, marking directories', async () => {
    const out = (await call('list_files', {}, rgPath)).content as string;
    const names = out.split('\n');
    expect(names).toContain('README.md');
    expect(names).toContain('src/');
    expect(names).not.toContain('.dispatch/');
    expect(names).not.toContain('.git/');
    const inSrc = (await call('list_files', { path: 'src' }, rgPath))
      .content as string;
    expect(inSrc.split('\n')).toEqual(['a.ts', 'deep/']);
  });

  it('matches a glob recursively, without following links out', async () => {
    const out = (await call('list_files', { glob: '**/*.ts' }, rgPath))
      .content as string;
    expect(out.split('\n')).toEqual(['src/a.ts', 'src/deep/b.ts']);
    const all = (await call('list_files', { glob: '**/*.txt' }, rgPath))
      .content as string;
    expect(all).not.toContain('secret');
    expect(all).not.toContain('config');
  });

  it('matches a glob relative to the path, reporting root-relative paths', async () => {
    const out = (
      await call('list_files', { path: 'src', glob: 'deep/*.ts' }, rgPath)
    ).content as string;
    expect(out.split('\n')).toEqual(['src/deep/b.ts']);
    const hits = (
      await call(
        'grep',
        { pattern: 'needle', path: 'src', glob: 'deep/*.ts' },
        rgPath
      )
    ).content as string;
    expect(hits).toContain('src/deep/b.ts:1:');
    expect(hits).not.toContain('src/a.ts');
  });

  it('refuses paths outside the root', async () => {
    for (const path of ['..', '/', 'leak-dir', '.dispatch']) {
      expect((await call('list_files', { path }, rgPath)).isError).toBe(true);
    }
  });
});

describe('list_files caps', () => {
  it('stops at 1000 entries', async () => {
    const dir = join(root, 'crowd');
    mkdirSync(dir);
    for (let i = 0; i < 1100; i++) writeFileSync(join(dir, `f${i}.txt`), '');
    try {
      const out = (await call('list_files', { path: 'crowd' }))
        .content as string;
      const lines = out.split('\n');
      expect(lines.filter((l) => l.endsWith('.txt')).length).toBe(1000);
      expect(out).toContain('results truncated');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hardening', () => {
  it('refuses a FIFO rather than blocking on it', async () => {
    const fifo = join(root, 'pipe');
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
    try {
      const started = Date.now();
      const out = await call('read_file', { path: 'pipe' });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(out.isError).toBe(true);
      expect(out.content).toContain('not a regular file');
    } finally {
      rmSync(fifo, { force: true });
    }
  });

  it('refuses a symlink into .dispatch and a relative symlinked parent', async () => {
    symlinkSync('.dispatch', join(root, 'cfg'));
    mkdirSync(join(root, 'sub'));
    symlinkSync('../..', join(root, 'sub', 'up2'));
    try {
      for (const rgPath of [RG, null]) {
        for (const path of ['cfg/config.yml', 'sub/up2/outside/secret.txt']) {
          const read = await call('read_file', { path }, rgPath);
          expect(read.isError).toBe(true);
          expect(String(read.content)).not.toContain('secret\n');
        }
        for (const path of ['cfg', 'sub/up2', 'sub/up2/outside']) {
          expect(
            (await call('grep', { pattern: 'needle', path }, rgPath)).isError
          ).toBe(true);
          expect((await call('list_files', { path }, rgPath)).isError).toBe(
            true
          );
        }
        const all = String(
          (await call('grep', { pattern: 'needle' }, rgPath)).content
        );
        expect(all).not.toContain('secret');
        expect(all).not.toContain('outside');
      }
    } finally {
      rmSync(join(root, 'cfg'), { force: true });
      rmSync(join(root, 'sub'), { recursive: true, force: true });
    }
  });

  it('shows the clipped head of a first line longer than 64MB', async () => {
    const huge = join(root, 'huge.txt');
    writeFileSync(huge, 'y'.repeat(65 * 1024 * 1024));
    try {
      const out = await call('read_file', { path: 'huge.txt' });
      expect(out.isError).toBe(false);
      const text = String(out.content);
      expect(text.startsWith(`1\t${'y'.repeat(2000)} [line truncated]`)).toBe(
        true
      );
      expect(text.length).toBeLessThan(2200);
      expect(text).toContain('64MB');
    } finally {
      rmSync(huge, { force: true });
    }
  });

  it('skips an unreadable file in the fallback grep instead of failing', async () => {
    const locked = join(root, 'src', 'locked.ts');
    writeFileSync(locked, 'needle locked\n');
    chmodSync(locked, 0o000);
    try {
      const out = await call('grep', { pattern: 'needle' }, null);
      expect(out.isError).toBe(false);
      expect(out.content).toContain('src/a.ts:1:');
      expect(out.content).not.toContain('locked');
    } finally {
      chmodSync(locked, 0o644);
      rmSync(locked, { force: true });
    }
  });

  it('time-caps the fallback walk for grep and list_files', async () => {
    const tools = plannerReadTools(root, { rgPath: null, searchTimeoutMs: 0 });
    const grep = await tools.handler('grep', { pattern: 'needle' });
    expect(grep.isError).toBe(false);
    expect(grep.content).toContain('timed out');
    const list = await tools.handler('list_files', { glob: '**/*.ts' });
    expect(list.isError).toBe(false);
    expect(list.content).toContain('timed out');
  });
});
