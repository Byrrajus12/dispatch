import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type CliContext, CliError } from '../context.js';
import { projectRoot } from '../projectRoot.js';
import { ensureDaemon } from './daemon.js';
import { requireInitialized } from './task.js';

const ENTRY = join('apps', 'tui', 'src', 'main.tsx');

// True when `root` is the Dispatch checkout the running CLI belongs to: the CLI sits inside its
// packages/cli, which is @dispatch/cli. Anything else is a stranger's file, never run with our token.
function isOwnCheckout(root: string, startDir: string): boolean {
  const cliDir = join(root, 'packages', 'cli');
  const rel = relative(cliDir, startDir);
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  try {
    const pkg = JSON.parse(
      readFileSync(join(cliDir, 'package.json'), 'utf8')
    ) as { name?: unknown };
    return pkg.name === '@dispatch/cli';
  } catch {
    return false;
  }
}

/** Where the TUI lives: `DISPATCH_TUI_ENTRY`, else `apps/tui` in the checkout this CLI runs from. */
export function resolveTuiEntry(
  env: Record<string, string | undefined> = process.env,
  startDir: string = dirname(fileURLToPath(import.meta.url))
): string {
  const override = env.DISPATCH_TUI_ENTRY;
  if (override !== undefined && override !== '') return override;
  for (let dir = startDir; ; dir = dirname(dir)) {
    const candidate = join(dir, ENTRY);
    if (existsSync(candidate) && isOwnCheckout(dir, startDir)) return candidate;
    if (dirname(dir) === dir) break;
  }
  throw new CliError(
    'no Dispatch TUI found: run `dispatch tui` from a Dispatch checkout, or ' +
      'set DISPATCH_TUI_ENTRY to the TUI entry script.'
  );
}

export interface TuiLaunch {
  cmd: string;
  args: string[];
  env: Record<string, string | undefined>;
}

/** The bun command for the TUI; the token rides in the environment so `ps` never shows it. */
export function buildTuiLaunch(opts: {
  entry: string;
  root: string;
  port: number;
  token: string;
  env: Record<string, string | undefined>;
}): TuiLaunch {
  return {
    cmd: 'bun',
    args: [opts.entry, '--root', opts.root, '--port', String(opts.port)],
    env: { ...opts.env, DISPATCH_TUI_TOKEN: opts.token },
  };
}

/** Hands the terminal to the TUI and resolves with its exit code. */
export function runTui(launch: TuiLaunch): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.cmd, launch.args, {
      stdio: 'inherit',
      env: launch.env,
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'ENOENT'
          ? new CliError(
              'the TUI runs on bun, which is not on PATH: install it from https://bun.sh and try again.'
            )
          : new CliError(`could not start the TUI: ${err.message}`)
      );
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

export function registerTuiCommand(program: Command, ctx: CliContext): void {
  program
    .command('tui')
    .description('Open Dispatch in the terminal, starting dispatchd if needed')
    .option('--port <n>', 'port to use when starting dispatchd')
    .action(async (opts: { port?: string }) => {
      requireInitialized(ctx);
      const entry = resolveTuiEntry();
      const { port, agentToken } = await ensureDaemon(ctx, { port: opts.port });
      process.exitCode = await runTui(
        buildTuiLaunch({
          entry,
          root: projectRoot(ctx.cwd),
          port,
          token: agentToken,
          env: process.env,
        })
      );
    });
}
