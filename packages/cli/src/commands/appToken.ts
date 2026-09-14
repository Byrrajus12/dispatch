import { type CliContext, CliError } from '../context.js';
import { findRunningDaemon } from './daemon.js';
import { requireInitialized } from './task.js';

const NO_DAEMON_MESSAGE =
  'no dispatchd is running for this project — start one with: dispatch serve';

// Deciding anything — a scope request, a run's tool approval — needs the app
// token, which the daemon prints once on stdout and never writes down. A
// daemon started in the background by any other `dispatch` command sends that
// line to /dev/null, so its app token is gone for the life of the process —
// hence the second sentence.
function noAppTokenMessage(command: string): string {
  return (
    `${command} needs the daemon app token: pass --token, or set ` +
    'DISPATCH_APP_TOKEN, taking the value from the DISPATCH_APP_TOKEN line ' +
    '`dispatch serve` prints at startup. A daemon that another dispatch ' +
    'command auto-started in the background printed that line to /dev/null and ' +
    'cannot get it back: stop it and run `dispatch serve` instead.'
  );
}

// Never read from a file, unlike the agent token: an app token an agent could
// read out of the daemon home is the exact hole the two-token split closes.
export function resolveAppToken(
  explicit: string | undefined,
  command: string
): string {
  const value = explicit ?? process.env.DISPATCH_APP_TOKEN;
  if (value === undefined || value.trim() === '') {
    throw new CliError(noAppTokenMessage(command));
  }
  return value.trim();
}

// Attaches to a running daemon, never starting one: a daemon this command
// spawned would have minted an app token that no supplied `--token` matches.
export async function attachToRunningDaemon(
  ctx: CliContext
): Promise<{ baseUrl: string; agentToken: string }> {
  requireInitialized(ctx);
  const daemon = await findRunningDaemon(ctx.cwd);
  if (daemon === null) throw new CliError(NO_DAEMON_MESSAGE);
  return {
    baseUrl: `http://127.0.0.1:${daemon.port}`,
    agentToken: daemon.agentToken,
  };
}
