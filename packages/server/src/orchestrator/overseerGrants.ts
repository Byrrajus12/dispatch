import { isSimpleCommand, programName, shellWords } from './shellCommand.js';

/** How long "Allow for this conversation" lasts at most. */
export const GRANT_TTL_MS = 4 * 60 * 60 * 1000;

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
 * What a grant covers. A simple shell command (isSimpleCommand: one program,
 * plain arguments) grants its program; any other command line grants only that
 * exact text, with runs of spaces and tabs (never newlines) folded. A Codex
 * permissions ask grants exactly what it requested; any other tool's grant is the tool.
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
  const first = isSimpleCommand(command) ? shellWords(command)?.[0] : undefined;
  if (first !== undefined) return `${toolName}:${programName(first)}`;
  return `${toolName}:${command.replace(/[ \t]+/g, ' ').replace(/^ | $/g, '')}`;
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
