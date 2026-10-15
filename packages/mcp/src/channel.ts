import { untrustedInline } from '@dispatch-foo/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { UnreadMessage } from './unread.js';
import { fetchUnread } from './unread.js';

// Claude Code channels: a server that declares `claude/channel` may push
// `notifications/claude/channel` events straight into the session, even an
// idle one. Used for mail addressed to this session; channel traffic and the
// read state stay with inbox_read (a pushed message is not read).

export const CHANNEL_CAPABILITY = 'claude/channel';
const CHANNEL_METHOD = 'notifications/claude/channel';
const DEFAULT_POLL_MS = 5000;

/** Whether `clientName` is a client that renders channel events. */
export function supportsChannels(clientName: string | undefined): boolean {
  return clientName !== undefined && /^claude-code/i.test(clientName);
}

/** The channel event for one message: its body, and who sent it in `meta`
 *  (keys must be letters, digits and underscores). */
export function channelEvent(item: UnreadMessage): {
  content: string;
  meta: Record<string, string>;
} {
  return {
    content:
      `Message from ${untrustedInline(item.from)} (reply with msg_reply ` +
      `to ${item.messageId}): ${item.body}`,
    meta: { from: item.from, thread: item.thread, msg_id: item.messageId },
  };
}

/** Polls this session's mailbox and pushes each new direct message once.
 *  Returns a stop function; does nothing for clients without channels. */
export function startChannelPush(
  server: McpServer,
  rootDir: string,
  pollMs = DEFAULT_POLL_MS
): () => void {
  const clientName = server.server.getClientVersion()?.name;
  if (!supportsChannels(clientName)) return () => {};
  const pushed = new Set<string>();
  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const items = await fetchUnread(rootDir, clientName);
      for (const item of items ?? []) {
        if (item.via !== 'direct' || pushed.has(item.deliveryId)) continue;
        pushed.add(item.deliveryId);
        await server.server.notification({
          method: CHANNEL_METHOD,
          params: channelEvent(item),
        });
      }
    } catch {
      // A closed transport or a daemon hiccup: the footer still delivers.
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), pollMs);
  timer.unref();
  return () => clearInterval(timer);
}
