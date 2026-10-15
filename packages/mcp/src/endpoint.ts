import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { daemonAuth, isDaemonHealthy, readDaemonFile } from './daemon.js';
import { readHubFile } from './hub/hubFile.js';

// Where an MCP session's agent mail goes: the project's dispatchd when one
// serves this project, else the machine hub, which every session on this
// machine shares whatever repo it is in. Each endpoint keeps its own agent
// identities, so the cache scope travels with it.

/** The cache scope standing for the machine hub in place of a project root. */
export const HUB_SCOPE = '\u0000hub';

export interface Endpoint {
  kind: 'daemon' | 'hub';
  port: number;
  /** The request-tier header: registers agents, never sends as one. */
  auth: Record<string, string>;
  /** The project root, or HUB_SCOPE, that agent identities are cached under. */
  scope: string;
}

/** Whether MCP sessions may fall back to the machine hub (DISPATCH_HUB=0 off). */
function hubEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DISPATCH_HUB !== '0';
}

/** The endpoint as its files say, without probing it: the project's daemon
 *  file wins; else the hub's, when the hub is on. */
export function currentEndpoint(projRoot: string): Endpoint | null {
  const daemon = readDaemonFile(projRoot);
  if (daemon !== null)
    return {
      kind: 'daemon',
      port: daemon.port,
      auth: daemonAuth(daemon),
      scope: projRoot,
    };
  if (!hubEnabled()) return null;
  const hub = readHubFile();
  return hub === null
    ? null
    : {
        kind: 'hub',
        port: hub.port,
        auth: { authorization: `Bearer ${hub.token}` },
        scope: HUB_SCOPE,
      };
}

/** The scope agent identities for `projRoot` are cached under right now. */
export function currentScope(projRoot: string): string {
  return readDaemonFile(projRoot) !== null || !hubEnabled()
    ? projRoot
    : HUB_SCOPE;
}

const HUB_START_TIMEOUT_MS = 5000;

/** A live endpoint: the project's dispatchd if it answers, else the machine
 *  hub, started when none runs; an error says why there is neither. */
export async function liveEndpoint(
  projRoot: string
): Promise<Endpoint | { error: string }> {
  const daemon = readDaemonFile(projRoot);
  if (daemon !== null) {
    if (await isDaemonHealthy(daemon.port))
      return {
        kind: 'daemon',
        port: daemon.port,
        auth: daemonAuth(daemon),
        scope: projRoot,
      };
    return { error: 'dispatchd not running — start it with: dispatch serve' };
  }
  if (!hubEnabled())
    return { error: 'dispatchd not running — start it with: dispatch serve' };
  const running = await healthyHub();
  if (running !== null) return running;
  startHubProcess();
  const deadline = Date.now() + HUB_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const started = await healthyHub();
    if (started !== null) return started;
  }
  return { error: 'the Dispatch machine hub did not start in time' };
}

async function healthyHub(): Promise<Endpoint | null> {
  const hub = readHubFile();
  if (hub === null || !(await isDaemonHealthy(hub.port))) return null;
  return {
    kind: 'hub',
    port: hub.port,
    auth: { authorization: `Bearer ${hub.token}` },
    scope: HUB_SCOPE,
  };
}

// This package's own entry point, built (dist/bin.js) or source (src/bin.ts).
function binPath(): string | null {
  for (const name of ['./bin.js', './bin.ts']) {
    const path = fileURLToPath(new URL(name, import.meta.url));
    if (existsSync(path)) return path;
  }
  return null;
}

// Starts `dispatch-mcp hub` detached; the hub takes its own start lock, so
// racing MCP servers that all get here still leave one hub running.
function startHubProcess(): void {
  const bin = binPath();
  if (bin === null) return;
  const child = spawn(process.execPath, [bin, 'hub'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}
