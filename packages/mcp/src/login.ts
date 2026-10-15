import { hubDir, readHubFile } from '@dispatch-foo/core';
import { rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import type { TeamFile } from './hub/team.js';
import {
  readTeamFile,
  removeTeamFile,
  teamServer,
  writeTeamFile,
} from './hub/team.js';

// Signing this machine in to a team (RFC 8628 device flow against the team
// service): the person approves a short code in their browser, and the
// machine hub restarts as a member of that team.

export interface DeviceLogin {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  /** Resolves once the person approves (or denies, or the code expires). */
  done: Promise<{ ok: true; team: TeamFile } | { ok: false; error: string }>;
}

const DEFAULT_INTERVAL_SEC = 3;

/** Starts a sign-in; `done` settles when it finishes. */
export async function startDeviceLogin(
  server: string = teamServer(),
  client = `dispatch-mcp on ${hostname().split('.')[0] ?? 'this machine'}`
): Promise<DeviceLogin | { error: string }> {
  let started: {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval?: number;
  };
  try {
    const res = await fetch(`${server}/api/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { error: `${server} answered ${res.status}` };
    started = (await res.json()) as typeof started;
  } catch (err) {
    return { error: `cannot reach ${server}: ${(err as Error).message}` };
  }
  const interval = (started.interval ?? DEFAULT_INTERVAL_SEC) * 1000;
  const deadline = Date.now() + started.expires_in * 1000;
  const done = (async (): Promise<
    { ok: true; team: TeamFile } | { ok: false; error: string }
  > => {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      let body: {
        error?: string;
        token?: string;
        handle?: string;
        device?: string;
        team?: { id: string; name: string };
      };
      try {
        const res = await fetch(`${server}/api/device/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ device_code: started.device_code }),
          signal: AbortSignal.timeout(15_000),
        });
        body = (await res.json()) as typeof body;
      } catch {
        continue;
      }
      if (body.error === 'authorization_pending') continue;
      if (body.error !== undefined)
        return {
          ok: false,
          error:
            body.error === 'access_denied'
              ? 'the sign-in was denied'
              : 'the code expired; start again',
        };
      if (
        body.token === undefined ||
        body.handle === undefined ||
        body.device === undefined ||
        body.team === undefined
      )
        return {
          ok: false,
          error: 'the team service sent an incomplete answer',
        };
      const team: TeamFile = {
        server,
        token: body.token,
        handle: body.handle,
        team: body.team,
        device: body.device,
      };
      joinTeam(team);
      return { ok: true, team };
    }
    return { ok: false, error: 'the code expired; start again' };
  })();
  return {
    userCode: started.user_code,
    verificationUri: started.verification_uri,
    verificationUriComplete: started.verification_uri_complete,
    done,
  };
}

// Saves the sign-in and restarts the machine hub as a team member.
function joinTeam(team: TeamFile): void {
  writeTeamFile(team);
  restartHub();
}

/** Forgets the team sign-in and restarts the machine hub off the team. */
export function logout(): boolean {
  const had = readTeamFile() !== null;
  removeTeamFile();
  restartHub();
  return had;
}

// The hub's agents re-register (under the new handle) on their next call,
// against a fresh hub that reads the sign-in anew.
function restartHub(): void {
  rmSync(join(hubDir(), '..', 'agents', 'hub'), {
    recursive: true,
    force: true,
  });
  const running = readHubFile();
  if (running !== null) {
    try {
      process.kill(running.pid, 'SIGTERM');
    } catch {
      // Already gone; the next MCP call starts a fresh hub.
    }
  }
}
