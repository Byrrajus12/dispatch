import { dequotedCommand } from '../floor.js';

/** How long "Allow for this conversation" lasts at most. */
export const GRANT_TTL_MS = 4 * 60 * 60 * 1000;

// Shell syntax that lets one command line run more than its first program.
const COMPOUND = /[;&|$`<>\n\r]/;

// Programs that run another program, so their own name says nothing about what runs.
const WRAPPER_PROGRAMS = new Set([
  'env',
  'exec',
  'command',
  'builtin',
  'xargs',
  'sudo',
  'doas',
  'su',
  'nice',
  'nohup',
  'time',
  'timeout',
  'stdbuf',
  'ionice',
  'chroot',
  'watch',
  'eval',
  'source',
  '.',
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
]);

// The program a shell command runs, past env assignments and a path.
function programOf(command: string): string | null {
  const words = command.trim().split(/\s+/);
  const first = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  if (first === undefined || first === '') return null;
  return first.slice(first.lastIndexOf('/') + 1);
}

// Plain JSON with object keys sorted, so the same request always gives the same key.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * What a grant covers. A simple shell command (Bash, a Codex command) grants
 * its program; one with operators, substitutions or a wrapper program grants
 * only that exact command line. A Codex permissions ask grants exactly what it
 * requested; any other tool's grant is the tool.
 */
export function grantKey(toolName: string, input: unknown): string {
  if (toolName === 'codex.permissions') {
    const permissions =
      typeof input === 'object' && input !== null
        ? (input as { permissions?: unknown }).permissions
        : undefined;
    return `${toolName}:${stableJson(permissions ?? null)}`;
  }
  if (toolName !== 'Bash' && toolName !== 'codex.commandExecution') {
    return toolName;
  }
  const command =
    typeof input === 'object' && input !== null
      ? (input as { command?: unknown }).command
      : undefined;
  if (typeof command !== 'string') return toolName;
  const program = programOf(dequotedCommand(command));
  if (program === null) return toolName;
  if (COMPOUND.test(command) || WRAPPER_PROGRAMS.has(program)) {
    return `${toolName}:${command.trim().replace(/\s+/g, ' ')}`;
  }
  return `${toolName}:${program}`;
}

interface Grant {
  grantedAt: number;
  expiresAt: number;
  /** The session it was granted in; a new session (a context rollover) ends it. */
  sessionId: string | undefined;
}

export interface GrantView {
  key: string;
  grantedAt: string;
  expiresAt: string;
}

/** Per-conversation grants that end at four hours or the next rollover, whichever is first. */
export class GrantStore {
  private readonly byConversation = new Map<string, Map<string, Grant>>();

  grant(
    conversationId: string,
    key: string,
    now: number,
    sessionId: string | undefined
  ): void {
    const grants = this.byConversation.get(conversationId) ?? new Map();
    grants.set(key, {
      grantedAt: now,
      expiresAt: now + GRANT_TTL_MS,
      sessionId,
    });
    this.byConversation.set(conversationId, grants);
  }

  allows(
    conversationId: string,
    key: string,
    now: number,
    sessionId: string | undefined
  ): boolean {
    const grants = this.byConversation.get(conversationId);
    const grant = grants?.get(key);
    if (grants === undefined || grant === undefined) return false;
    const rolledOver =
      grant.sessionId !== undefined && grant.sessionId !== sessionId;
    if (now >= grant.expiresAt || rolledOver) {
      grants.delete(key);
      return false;
    }
    return true;
  }

  list(conversationId: string, now: number): GrantView[] {
    const grants = this.byConversation.get(conversationId);
    if (grants === undefined) return [];
    const out: GrantView[] = [];
    for (const [key, grant] of grants) {
      if (now >= grant.expiresAt) {
        grants.delete(key);
        continue;
      }
      out.push({
        key,
        grantedAt: new Date(grant.grantedAt).toISOString(),
        expiresAt: new Date(grant.expiresAt).toISOString(),
      });
    }
    return out;
  }

  revoke(conversationId: string, key: string): boolean {
    return this.byConversation.get(conversationId)?.delete(key) ?? false;
  }

  clear(conversationId: string): void {
    this.byConversation.delete(conversationId);
  }
}
