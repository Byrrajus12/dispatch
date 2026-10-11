import { childEnv } from '../childEnv.js';
import {
  type CredentialsFile,
  readCredentials,
  updateCredentialsFile,
} from '../credentials.js';
import { PROVIDERS } from './providers.js';

function agentKeyVars(): Set<string> {
  return new Set(
    PROVIDERS.flatMap((p) => (p.apiKeyEnv === undefined ? [] : [p.apiKeyEnv]))
  );
}

export function readAgentKeys(): Record<string, string> {
  try {
    return { ...(readCredentials().agents ?? {}) };
  } catch {
    // An unreadable credentials file costs agents their saved keys, not their run.
    return {};
  }
}

/** Saves (or with null, clears) an agent API key under its env var name. */
export function writeAgentKey(envVar: string, apiKey: string | null): void {
  if (!agentKeyVars().has(envVar))
    throw new Error(`${envVar} is not an agent key`);
  updateCredentialsFile((file) => {
    const agents = { ...(file.agents ?? {}) };
    if (apiKey === null || apiKey.trim() === '') delete agents[envVar];
    else agents[envVar] = apiKey.trim();
    const next: CredentialsFile = { ...file, agents };
    if (Object.keys(agents).length === 0) delete next.agents;
    return next;
  });
}

/** Env for an agent process: saved keys, overridden by the real env, then `extra`. */
export function agentEnv(
  extra: Record<string, string> = {}
): Record<string, string> {
  return { ...readAgentKeys(), ...childEnv(extra) };
}
