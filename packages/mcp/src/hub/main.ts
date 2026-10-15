import { handleFromEmail } from '@dispatch-foo/core';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';

import { MCP_SERVER_VERSION } from '../server.js';
import {
  hubDir,
  readHubFile,
  removeHubFile,
  takeStartLock,
  writeHubFile,
} from './hubFile.js';
import { startHub } from './server.js';

// `dispatch-mcp hub`: runs the machine hub until it has sat idle for
// IDLE_SHUTDOWN_MS, publishing ~/.dispatch/hub/hub.json while it serves.

const IDLE_SHUTDOWN_MS = 30 * 60 * 1000;
const IDLE_CHECK_MS = 60 * 1000;

/** This user's handle: from their global git email, as dispatchd derives a
 *  project's operator, else their OS user name. */
function ownHandle(): string {
  try {
    const email = execFileSync('git', ['config', '--global', 'user.email'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (email !== '') return handleFromEmail(email, new Set());
  } catch {
    // No git, or no global email: fall back to the OS user.
  }
  return handleFromEmail(`${userInfo().username}@localhost`, new Set());
}

/** Runs the hub in this process; resolves once it has shut down. Exits at
 *  once when another live hub holds the start lock. */
export async function runHub(): Promise<void> {
  const release = takeStartLock();
  if (release === null) return;
  const existing = readHubFile();
  if (existing !== null && existing.pid !== process.pid) {
    try {
      process.kill(existing.pid, 0);
      release();
      return;
    } catch {
      // A stale file from a hub that died: serve in its place.
    }
  }
  const token = randomBytes(32).toString('hex');
  const hub = await startHub({ dir: hubDir(), token, handle: ownHandle() });
  writeHubFile({
    port: hub.port,
    pid: process.pid,
    token,
    version: MCP_SERVER_VERSION,
    startedAt: new Date().toISOString(),
  });
  release();

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      clearInterval(idle);
      removeHubFile(process.pid);
      void hub.close().then(resolve);
    };
    const idle = setInterval(() => {
      if (Date.now() - hub.lastActivity() > IDLE_SHUTDOWN_MS) stop();
    }, IDLE_CHECK_MS);
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}
