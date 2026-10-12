import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Single-quotes a path for bash, so a home directory with a space or a quote
// in it still lands on PATH as one entry.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Prefixes a verify command so it runs with the tool versions the worktree
 * pins in `.prototools`, rather than whatever a login shell finds first.
 *
 * Verify steps run under `bash -lc`, and on macOS `/etc/profile` runs
 * `path_helper`, which moves `/usr/local/bin` and `/opt/homebrew/bin` ahead of
 * anything the daemon put on PATH. A Homebrew pnpm or a stale moon symlink
 * there then wins. Homebrew's pnpm 12 reads `packageManager: pnpm@11.9.0` and
 * tries to switch to `@pnpm/exe@11.9.0`, which ships no darwin-x64 binary, so
 * every install on an Intel Mac failed. proto's shims resolve the pinned
 * version per directory (proto installs pnpm as the JS package, which runs on
 * any host node runs on), so putting them first inside the shell fixes pnpm,
 * moon and node together and keeps following `.prototools` as the pins move.
 *
 * Returns the command unchanged when the worktree pins nothing or proto is not
 * installed, so projects that don't use proto see no difference.
 */
export function withProtoShims(
  worktreePath: string,
  command: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!existsSync(join(worktreePath, '.prototools'))) return command;
  const protoHome = env.PROTO_HOME ?? join(homedir(), '.proto');
  const shims = join(protoHome, 'shims');
  if (!existsSync(shims)) return command;
  const bin = join(protoHome, 'bin');
  return `export PATH=${shellQuote(shims)}:${shellQuote(bin)}:"$PATH"; ${command}`;
}
