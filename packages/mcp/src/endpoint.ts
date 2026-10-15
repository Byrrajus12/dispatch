import { readHubFile, verifyHub } from '@dispatch-foo/core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { daemonAuth, isDaemonHealthy, readDaemonFile } from './daemon.js';

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

/** The endpoint already serving `projRoot`, without starting one: the
 *  project's daemon file wins; else a hub that proves it is the hub. */
export async function knownEndpoint(
  projRoot: string
): Promise<Endpoint | null> {
  const daemon = readDaemonFile(projRoot);
  if (daemon !== null)
    return {
      kind: 'daemon',
      port: daemon.port,
      auth: daemonAuth(daemon),
      scope: projRoot,
    };
  return hubEnabled() ? verifiedHub() : null;
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
  const running = await verifiedHub();
  if (running !== null) return running;
  startHubProcess();
  const deadline = Date.now() + HUB_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const started = await verifiedHub();
    if (started !== null) return started;
  }
  return { error: 'the Dispatch machine hub did not start in time' };
}

// How long a hub's proof of identity is trusted before it is asked again.
const VERIFIED_FOR_MS = 30_000;
let verified: { port: number; id: string; at: number } | null = null;

// The hub named in hub.json, once its /api/health echoes that file's id: no
// token goes to a port some other process took after the hub died.
async function verifiedHub(): Promise<Endpoint | null> {
  const hub = readHubFile();
  if (hub === null) return null;
  const endpoint: Endpoint = {
    kind: 'hub',
    port: hub.port,
    auth: { authorization: `Bearer ${hub.token}` },
    scope: HUB_SCOPE,
  };
  if (
    verified !== null &&
    verified.port === hub.port &&
    verified.id === hub.id &&
    Date.now() - verified.at < VERIFIED_FOR_MS
  )
    return endpoint;
  if (!(await verifyHub(hub))) return null;
  verified = { port: hub.port, id: hub.id, at: Date.now() };
  return endpoint;
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
