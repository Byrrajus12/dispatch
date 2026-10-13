import { accessSync, constants, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface PathIo {
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  listDir: (path: string) => string[];
  readText: (path: string) => string | null;
}

function versionKey(v: string): number[] {
  return v
    .replace(/^v/, '')
    .split('.')
    .map((n) => {
      const parsed = Number.parseInt(n, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    });
}

function newestFirst(a: string, b: string): number {
  const [x, y] = [versionKey(a), versionKey(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? 0) - (x[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// nvm's active node bin: the default alias's best match, else the newest install.
function nvmBin(io: PathIo): string | null {
  const root = join(io.home, '.nvm', 'versions', 'node');
  const versions = io
    .listDir(root)
    .filter((v) => v.startsWith('v'))
    .sort(newestFirst);
  if (versions.length === 0) return null;
  const alias = io
    .readText(join(io.home, '.nvm', 'alias', 'default'))
    ?.trim()
    .replace(/^v/, '');
  const chosen =
    alias === undefined || alias === ''
      ? versions[0]
      : (versions.find(
          (v) => v === `v${alias}` || v.startsWith(`v${alias}.`)
        ) ?? versions[0]);
  return join(root, chosen, 'bin');
}

/**
 * `current` plus the places agent CLIs get installed that a Finder-launched app's
 * PATH misses. Appends only, so an explicit PATH keeps its own precedence.
 */
export function widenPath(current: string, io: PathIo): string {
  const parts = current.split(delimiter).filter((p) => p !== '');
  const extras = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(io.home, '.local', 'bin'),
    join(io.home, '.claude', 'local'),
    join(io.home, '.bun', 'bin'),
    join(io.home, '.cargo', 'bin'),
    join(io.home, '.npm-global', 'bin'),
    join(io.home, '.volta', 'bin'),
    io.env.PNPM_HOME,
    nvmBin(io),
  ];
  for (const extra of extras) {
    if (
      extra !== undefined &&
      extra !== null &&
      extra !== '' &&
      !parts.includes(extra)
    ) {
      parts.push(extra);
    }
  }
  return parts.join(delimiter);
}

/** `widenPath` over this process's real PATH, home and filesystem. */
export function widenedPath(): string {
  return widenPath(process.env.PATH ?? '', {
    home: homedir(),
    env: process.env,
    platform: process.platform,
    listDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
    readText: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
  });
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First `binary` on `path`; works under Node, unlike Bun.which. On Windows a bare
 * name is also tried with each PATHEXT extension, since installers ship `claude.exe`
 * or `codex.cmd` and nothing named plain `claude` (as `mergeDriverSetup`'s lookup does). */
export function whichOnPath(
  binary: string,
  path: string,
  isExecutable: (p: string) => boolean = executable,
  platform: NodeJS.Platform = process.platform
): string | null {
  const exts =
    platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')]
      : [''];
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, binary) + ext;
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}
