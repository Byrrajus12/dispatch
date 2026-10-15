import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { DaemonFileInfo } from './daemon.js';
import {
  daemonAuth,
  isDaemonHealthy,
  readDaemonFile,
  requestDeadline,
} from './daemon.js';

// Messaging identity: who an MCP tool call speaks as — a live run speaks as
// itself; everything else self-registers a per-project cached agent identity.

export interface MessagingCredential {
  token: string;
  address: string | null;
  kind: 'run' | 'agent';
  /** Set on a session credential: the client identity that vouched for it. */
  parent?: string;
}

function dispatchHome(): string {
  const home = process.env.DISPATCH_HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

// Keys a project's cached tokens by its realpath, so the same project
// reached via a symlink or a relative path shares one cache directory.
function projectKey(rootDir: string): string {
  let real: string;
  try {
    real = realpathSync(rootDir);
  } catch {
    real = rootDir;
  }
  return createHash('sha256').update(real).digest('hex').slice(0, 12);
}

function agentsDir(rootDir: string): string {
  return join(dispatchHome(), '.dispatch', 'agents', projectKey(rootDir));
}

/** Where `rootDir` caches `name`'s registration — exported so a tool error
 *  can point a human at the exact file to delete. */
export function agentTokenFilePath(rootDir: string, name: string): string {
  return join(agentsDir(rootDir), `${name}.json`);
}

interface StoredAgentToken {
  token: string;
  address: string;
}

// A corrupt or missing cache file both read as "no cache" — the same
// resilience readDaemonFile gives a truncated daemon file.
function readStoredToken(path: string): StoredAgentToken | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      token?: unknown;
      address?: unknown;
    };
    if (
      typeof parsed.token === 'string' &&
      typeof parsed.address === 'string'
    ) {
      return { token: parsed.token, address: parsed.address };
    }
  } catch {
    // Fall through to null below.
  }
  return null;
}

// Through a temp file and a rename, so a crash never leaves half a cache file.
function writeStoredToken(path: string, value: StoredAgentToken): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}

// Moves a cache file that exists but will not read aside, answering whether it
// did: its name stays registered, so the caller re-keys that name.
function setAsideUnreadable(path: string): boolean {
  if (!existsSync(path) || readStoredToken(path) !== null) return false;
  renameSync(path, `${path}.corrupt-${Date.now()}`);
  pruneSetAside(path);
  return true;
}

// Keeps only the newest KEEP_SET_ASIDE copies of a cache file set aside.
const KEEP_SET_ASIDE = 3;
function pruneSetAside(path: string): void {
  const prefix = `${basename(path)}.corrupt-`;
  const copies = readdirSync(dirname(path))
    .filter((f) => f.startsWith(prefix))
    .sort(
      (a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length))
    );
  for (const f of copies.slice(0, -KEEP_SET_ASIDE))
    rmSync(join(dirname(path), f), { force: true });
}

// Self-heal step: drops the cached token the daemon just called unknown, but
// keeps a newer one a parallel heal has already written in its place.
export function forgetAgentToken(
  rootDir: string,
  name: string,
  rejectedToken: string
): void {
  const path = agentTokenFilePath(rootDir, name);
  if (readStoredToken(path)?.token !== rejectedToken) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // Already gone — nothing to clean up.
  }
}

// Mirrors packages/server/src/messaging/routes.ts's normalizeAgentName
// exactly (not imported — MIT must not depend on the FSL server).
function normalizeAgentName(raw: string): string {
  const lowered = raw.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return lowered.replace(/^[^a-z0-9]+/, '').slice(0, 40);
}

// The first label of a hostname: "Wyats-MacBook-Pro" out of
// "Wyats-MacBook-Pro.local".
function shortHost(host: string): string {
  const dot = host.indexOf('.');
  return dot === -1 ? host : host.slice(0, dot);
}

/** DISPATCH_AGENT_NAME wins; otherwise "<mcp client>.<short hostname>",
 *  normalized like the server's own registration handler. */
export function agentName(
  env: NodeJS.ProcessEnv,
  clientName: string | undefined,
  host: string
): string {
  const override = env.DISPATCH_AGENT_NAME;
  if (override !== undefined && override.trim() !== '') {
    return normalizeAgentName(override);
  }
  const client =
    clientName !== undefined && clientName.trim() !== '' ? clientName : 'agent';
  return normalizeAgentName(`${client}.${shortHost(host)}`);
}

// Dedupes concurrent registrations for the same (project, name) pair so two
// tool calls racing past an empty cache register exactly once between them.
const inFlightRegistrations = new Map<
  string,
  Promise<MessagingCredential | { error: string }>
>();

async function registerAgent(
  rootDir: string,
  daemon: DaemonFileInfo,
  name: string,
  clientName: string | undefined,
  rekey = false
): Promise<MessagingCredential | { error: string }> {
  const key = `${rootDir}\u0000${name}`;
  const existing = inFlightRegistrations.get(key);
  if (existing !== undefined) return existing;
  const promise = doRegisterAgent(rootDir, daemon, name, clientName, rekey);
  inFlightRegistrations.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightRegistrations.delete(key);
  }
}

// The one real POST /api/agents/register (registerAgent wraps it with the
// in-flight dedup). A 409 re-checks the cache first — a parallel writer.
async function doRegisterAgent(
  rootDir: string,
  daemon: DaemonFileInfo,
  name: string,
  clientName: string | undefined,
  rekey: boolean
): Promise<MessagingCredential | { error: string }> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${daemon.port}/api/agents/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...daemonAuth(daemon) },
      body: JSON.stringify({
        name,
        client:
          clientName !== undefined && clientName.trim() !== ''
            ? clientName
            : 'unknown',
        ...(rekey ? { rekey: true } : {}),
      }),
      signal: requestDeadline(),
    });
  } catch (err) {
    return { error: `agent registration failed: ${(err as Error).message}` };
  }
  const path = agentTokenFilePath(rootDir, name);
  if (res.status === 409) {
    const cached = readStoredToken(path);
    if (cached !== null) {
      return { token: cached.token, address: cached.address, kind: 'agent' };
    }
    return {
      error:
        `${name} is already registered; revoke it in Dispatch → Settings → ` +
        `Agents, then delete ${path}`,
    };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      error: `agent registration failed: ${body.error ?? `HTTP ${res.status}`}`,
    };
  }
  const created = (await res.json()) as { address: string; token: string };
  writeStoredToken(path, { token: created.token, address: created.address });
  return { token: created.token, address: created.address, kind: 'agent' };
}

// A dispatched run's token, read from the 0600 file DISPATCH_RUN_TOKEN_FILE
// names; null outside a run. An unreadable file errors rather than registering.
function runCredential(): MessagingCredential | { error: string } | null {
  const file = process.env.DISPATCH_RUN_TOKEN_FILE;
  if (file === undefined || file === '') return null;
  let token: string;
  try {
    token = readFileSync(file, 'utf8').trim();
  } catch (err) {
    return {
      error: `cannot read this run's token (${file}): ${(err as Error).message}`,
    };
  }
  if (token === '') return { error: `cannot read this run's token (${file})` };
  const runId = process.env.DISPATCH_RUN_ID;
  return {
    token,
    kind: 'run',
    address: runId !== undefined && runId !== '' ? `run:${runId}` : null,
  };
}

// A credential this process already holds (a run's token file, or a cached
// agent registration), without registering; null when there is none.
export function existingMessagingCredential(
  rootDir: string,
  clientName: string | undefined
): MessagingCredential | { error: string } | null {
  const run = runCredential();
  if (run !== null) return run;
  if (sessionsEnabled(process.env)) {
    const session = readStoredSession(
      sessionTokenFilePath(rootDir, sessionName(clientName, sessionKey()))
    );
    if (session !== null) return session;
  }
  const cached = readStoredToken(
    agentTokenFilePath(rootDir, agentName(process.env, clientName, hostname()))
  );
  return cached === null
    ? null
    : { token: cached.token, address: cached.address, kind: 'agent' };
}

/** A run's own token; else this session's own identity once its client
 *  identity is approved; else that client identity, self-registering it.
 *  `rootDir` must already be the project root (toolKit.ts's `projectRoot`). */
export async function messagingCredential(
  rootDir: string,
  clientName: string | undefined
): Promise<MessagingCredential | { error: string }> {
  const client = await clientCredential(rootDir, clientName);
  if ('error' in client || client.kind !== 'agent') return client;
  if (!sessionsEnabled(process.env)) return client;
  return (await sessionCredential(rootDir, clientName, client)) ?? client;
}

// The run's token, or the client identity (`<client>.<host>`) for this
// project: cached, or registered now and pending until a human approves it.
async function clientCredential(
  rootDir: string,
  clientName: string | undefined
): Promise<MessagingCredential | { error: string }> {
  const run = runCredential();
  if (run !== null) return run;
  const cached = readStoredToken(
    agentTokenFilePath(rootDir, agentName(process.env, clientName, hostname()))
  );
  if (cached !== null)
    return { token: cached.token, address: cached.address, kind: 'agent' };

  const name = agentName(process.env, clientName, hostname());
  const daemon = readDaemonFile(rootDir);
  if (daemon === null || !(await isDaemonHealthy(daemon.port))) {
    return {
      error:
        'dispatchd not running — cannot register this agent identity. Start it with: dispatch serve',
    };
  }
  // The name still holds the lost token, so a damaged cache re-keys it: the
  // daemon retires the old token and issues this name a new one.
  const rekey = setAsideUnreadable(agentTokenFilePath(rootDir, name));
  return registerAgent(rootDir, daemon, name, clientName, rekey);
}

// ---------------------------------------------------------------------------
// Sessions: each MCP server process speaks as its own agent,
// agent:<operator>/<client>-<sid>, vouched for by its client identity, so two
// sessions of one client in one project have separate inboxes.
// ---------------------------------------------------------------------------

/** Sessions are on unless a fixed name was asked for or they are switched off. */
export function sessionsEnabled(env: NodeJS.ProcessEnv): boolean {
  const fixed = env.DISPATCH_AGENT_NAME;
  if (fixed !== undefined && fixed.trim() !== '') return false;
  return env.DISPATCH_SESSIONS !== '0';
}

// The environment variables agent clients set to their own session id, most
// specific first; an MCP server restarted inside one session keeps its address.
const SESSION_KEY_VARS = [
  'DISPATCH_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
  'GEMINI_SESSION_ID',
] as const;

const PROCESS_SESSION_KEY = randomUUID();

/** The key a session's name is derived from: the client's session id, else
 *  one random id for this process. */
export function sessionKey(env: NodeJS.ProcessEnv = process.env): string {
  for (const name of SESSION_KEY_VARS) {
    const value = env[name];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return PROCESS_SESSION_KEY;
}

/** `<client>-<6 hex of sha256(key)>`, normalized like any agent name. */
export function sessionName(
  clientName: string | undefined,
  key: string
): string {
  const client = normalizeAgentName(
    clientName !== undefined && clientName.trim() !== '' ? clientName : 'agent'
  ).slice(0, 30);
  const sid = createHash('sha256').update(key).digest('hex').slice(0, 6);
  return normalizeAgentName(`${client}-${sid}`);
}

/** Where a session's registration is cached, beside its client identity's. */
export function sessionTokenFilePath(rootDir: string, name: string): string {
  return join(agentsDir(rootDir), 'sessions', `${name}.json`);
}

interface StoredSession extends StoredAgentToken {
  parent: string;
}

function readStoredSession(path: string): MessagingCredential | null {
  const stored = readStoredToken(path);
  if (stored === null) return null;
  try {
    const parent = (JSON.parse(readFileSync(path, 'utf8')) as StoredSession)
      .parent;
    if (typeof parent !== 'string') return null;
    return {
      token: stored.token,
      address: stored.address,
      kind: 'agent',
      parent,
    };
  } catch {
    return null;
  }
}

/** Drops a session's cached token after the daemon refused it. */
export function forgetSessionToken(
  rootDir: string,
  clientName: string | undefined
): void {
  rmSync(sessionTokenFilePath(rootDir, sessionName(clientName, sessionKey())), {
    force: true,
  });
}

// The branch checked out at `rootDir`, read from .git/HEAD (a worktree's .git
// file points at its own HEAD); undefined when detached or unreadable.
export function currentBranch(rootDir: string): string | undefined {
  try {
    let gitDir = join(rootDir, '.git');
    if (!statSync(gitDir).isDirectory()) {
      const pointer = readFileSync(gitDir, 'utf8').trim();
      if (!pointer.startsWith('gitdir: ')) return undefined;
      gitDir = pointer.slice('gitdir: '.length);
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/')
      ? head.slice('ref: refs/heads/'.length)
      : undefined;
  } catch {
    return undefined;
  }
}

/** What a session reports about itself when it registers. */
export function sessionMetaFor(
  rootDir: string,
  clientName: string | undefined
): Record<string, string> {
  const branch = currentBranch(rootDir);
  return {
    kind: 'session',
    client: clientName ?? 'unknown',
    cwd: rootDir,
    repo: basename(rootDir),
    pid: String(process.pid),
    ...(branch === undefined ? {} : { branch }),
  };
}

// After a refused session registration (client identity not approved yet),
// wait this long before asking again; meanwhile the client identity speaks.
const SESSION_RETRY_MS = 30_000;
const sessionRetryAt = new Map<string, number>();

// This session's credential: cached, or registered now under `client`; null
// when the daemon will not vouch for it yet.
async function sessionCredential(
  rootDir: string,
  clientName: string | undefined,
  client: MessagingCredential
): Promise<MessagingCredential | null> {
  const parent = client.address;
  if (parent === null) return null;
  const name = sessionName(clientName, sessionKey());
  const path = sessionTokenFilePath(rootDir, name);
  const cached = readStoredSession(path);
  if (cached !== null && cached.parent === parent) return cached;

  const retryKey = `${rootDir}\u0000${name}`;
  if ((sessionRetryAt.get(retryKey) ?? 0) > Date.now()) return null;
  const daemon = readDaemonFile(rootDir);
  if (daemon === null) return null;
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${daemon.port}/api/agents/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...daemonAuth(daemon) },
      body: JSON.stringify({
        name,
        client:
          clientName !== undefined && clientName.trim() !== ''
            ? clientName
            : 'unknown',
        parent,
        parentToken: client.token,
        meta: sessionMetaFor(rootDir, clientName),
      }),
      signal: requestDeadline(),
    });
  } catch {
    return null;
  }
  if (!res.ok) {
    sessionRetryAt.set(retryKey, Date.now() + SESSION_RETRY_MS);
    return null;
  }
  const created = (await res.json()) as { address: string; token: string };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(
    temp,
    JSON.stringify({
      token: created.token,
      address: created.address,
      parent,
    } satisfies StoredSession),
    { mode: 0o600 }
  );
  renameSync(temp, path);
  sessionRetryAt.delete(retryKey);
  return {
    token: created.token,
    address: created.address,
    kind: 'agent',
    parent,
  };
}
