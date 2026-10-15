import { untrustedInline } from '@dispatch-foo/core';

import { knownEndpoint, scopeFor } from './endpoint.js';
import { existingMessagingCredential } from './identity.js';
import type { ToolOutcome } from './toolKit.js';
import { projectRoot } from './toolKit.js';

// Unread mail for the agent identity this process already holds, so every
// tool result, hook and push can tell an agent to read its inbox. Never
// registers an identity or starts a daemon: no credential, a run's credential
// or no daemon means no summary.

export interface UnreadSummary {
  /** Unread deliveries in this identity's mailbox. */
  count: number;
  /** How many of them were addressed to this identity itself, not a channel. */
  direct: number;
  /** Distinct senders, newest first. */
  from: string[];
}

export interface UnreadMessage {
  deliveryId: string;
  messageId: string;
  thread: string;
  from: string;
  body: string;
  via: 'direct' | 'channel';
}

interface MailboxItemWire {
  delivery: { id: string; state: string; via?: string };
  message: { id: string; thread?: string; from: string; body?: string };
}

const UNREAD_STATES = 'held,notified,pushed';
// A probe is a nicety on top of a tool call, so it must never be the slow part.
const PROBE_TIMEOUT_MS = 1500;

/** The unread items of the identity this process holds, oldest first; null
 *  when it holds none, there is no daemon, or the daemon would not answer. */
export async function fetchUnread(
  rootDir: string,
  clientName: string | undefined
): Promise<UnreadMessage[] | null> {
  const root = projectRoot(rootDir);
  const credential = existingMessagingCredential(root, clientName);
  // A dispatched run's executor already hands it new mail mid-turn.
  if (credential === null || 'error' in credential || credential.kind === 'run')
    return null;
  return fetchUnreadAs(scopeFor(root, 'mail'), credential.token);
}

/** The unread items `token`'s holder has at `scope`'s endpoint (the hub, or
 *  a project's daemon), oldest first; null when it would not answer. */
export async function fetchUnreadAs(
  scope: string,
  token: string
): Promise<UnreadMessage[] | null> {
  const endpoint = await knownEndpoint(scope);
  if (endpoint === null) return null;
  try {
    const res = await fetch(
      `http://127.0.0.1:${endpoint.port}/api/mailbox?state=${UNREAD_STATES}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: MailboxItemWire[] };
    return (body.items ?? []).map((item) => ({
      deliveryId: item.delivery.id,
      messageId: item.message.id,
      thread: item.message.thread ?? item.message.id,
      from: item.message.from,
      body: item.message.body ?? '',
      via: item.delivery.via === 'channel' ? 'channel' : 'direct',
    }));
  } catch {
    return null;
  }
}

/** Counts and senders of `items`, senders newest first. */
export function summarize(items: readonly UnreadMessage[]): UnreadSummary {
  const from: string[] = [];
  for (const item of items.toReversed())
    if (!from.includes(item.from)) from.push(item.from);
  return {
    count: items.length,
    direct: items.filter((i) => i.via === 'direct').length,
    from,
  };
}

const PROBE_CACHE_MS = 5000;

export interface UnreadProbe {
  summary(): Promise<UnreadSummary | null>;
  /** Forgets the cached summary, e.g. once the inbox was just read. */
  invalidate(): void;
}

/** A cached unread probe: at most one mailbox read per PROBE_CACHE_MS. */
export function createUnreadProbe(
  rootDir: string,
  clientName: () => string | undefined,
  cacheMs = PROBE_CACHE_MS
): UnreadProbe {
  let cached: { at: number; value: UnreadSummary | null } | null = null;
  return {
    async summary() {
      const now = Date.now();
      if (cached !== null && now - cached.at < cacheMs) return cached.value;
      const items = await fetchUnread(rootDir, clientName());
      cached = { at: now, value: items === null ? null : summarize(items) };
      return cached.value;
    },
    invalidate() {
      cached = null;
    },
  };
}

const FOOTER_SENDERS = 3;

/** One line telling the agent it has mail, or null when it has none. */
export function unreadLine(summary: UnreadSummary | null): string | null {
  if (summary === null || summary.count === 0) return null;
  const shown = summary.from.slice(0, FOOTER_SENDERS).map(untrustedInline);
  const more = summary.from.length - shown.length;
  const senders =
    shown.length === 0
      ? ''
      : ` (from ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''})`;
  return `[dispatch] ${summary.count} unread${senders}. Call inbox_read.`;
}

/** `outcome` with the unread line appended and the count in `_meta`. */
export function withUnreadFooter(
  outcome: ToolOutcome,
  summary: UnreadSummary | null
): ToolOutcome {
  const line = unreadLine(summary);
  if (line === null || summary === null) return outcome;
  const meta =
    typeof outcome._meta === 'object' && outcome._meta !== null
      ? (outcome._meta as Record<string, unknown>)
      : {};
  return {
    ...outcome,
    content: [...outcome.content, { type: 'text', text: line }],
    _meta: { ...meta, 'dispatch/unread': summary.count },
  };
}
