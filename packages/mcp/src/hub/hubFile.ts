import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Where the machine hub keeps its state, and the file that tells MCP servers
// how to reach it: ~/.dispatch/hub/{messages.db,hub.json,hub.lock}.

/** What a running hub publishes about itself, readable only by its user. */
export interface HubFileInfo {
  port: number;
  pid: number;
  /** A random id the hub's /api/health echoes, so a client can tell the hub
   *  from some other process that took its port after it died. */
  id: string;
  /** The request-tier token: registers agents, never sends as anyone. */
  token: string;
  version: string;
  startedAt: string;
}

export function hubDir(): string {
  const home = process.env.DISPATCH_HOME;
  return join(
    home !== undefined && home !== '' ? home : homedir(),
    '.dispatch',
    'hub'
  );
}

function hubFilePath(): string {
  return join(hubDir(), 'hub.json');
}

/** The running hub's file, or null; a corrupt file reads as none. */
export function readHubFile(): HubFileInfo | null {
  const path = hubFilePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as HubFileInfo;
    return typeof parsed.port === 'number' &&
      typeof parsed.token === 'string' &&
      typeof parsed.id === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function writeHubFile(info: HubFileInfo): void {
  mkdirSync(hubDir(), { recursive: true, mode: 0o700 });
  const temp = `${hubFilePath()}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(info), { mode: 0o600 });
  renameSync(temp, hubFilePath());
}

/** Removes the hub file only if it still names this process. */
export function removeHubFile(pid: number): void {
  if (readHubFile()?.pid === pid) rmSync(hubFilePath(), { force: true });
}

function lockPath(): string {
  return join(hubDir(), 'hub.lock');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Takes the start lock, so racing MCP servers spawn one hub; a lock whose
 *  holder died is taken over. Returns a release function, or null if a live
 *  process holds it. */
export function takeStartLock(): (() => void) | null {
  mkdirSync(hubDir(), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath(), 'wx', 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        if (readFileSync(lockPath(), 'utf8') === String(process.pid))
          rmSync(lockPath(), { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = Number(readFileSync(lockPath(), 'utf8'));
      if (Number.isInteger(holder) && holder > 0 && pidAlive(holder))
        return null;
      rmSync(lockPath(), { force: true });
    }
  }
  return null;
}
