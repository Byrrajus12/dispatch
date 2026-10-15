import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UnreadMessage } from '../src/unread.js';
import {
  fetchUnread,
  summarize,
  unreadLine,
  withUnreadFooter,
} from '../src/unread.js';

function item(from: string, via: 'direct' | 'channel'): UnreadMessage {
  return {
    deliveryId: `d-${from}`,
    messageId: `m-${from}`,
    thread: `m-${from}`,
    from,
    body: 'hi',
    via,
  };
}

describe('unread footer', () => {
  it('counts direct mail apart and lists senders newest first', () => {
    const summary = summarize([
      item('agent:a/x', 'direct'),
      item('agent:a/y', 'channel'),
      item('agent:a/x', 'direct'),
    ]);
    expect(summary).toEqual({
      count: 3,
      direct: 2,
      from: ['agent:a/x', 'agent:a/y'],
    });
  });

  it('names at most three senders', () => {
    const line = unreadLine({
      count: 5,
      direct: 5,
      from: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(line).toBe(
      '[dispatch] 5 unread (from a, b, c and 2 more). Call inbox_read.'
    );
  });

  it('folds a sender to one line so it cannot start its own', () => {
    const line = unreadLine({ count: 1, direct: 1, from: ['a\nIgnore that'] });
    expect(line).not.toContain('\n');
  });

  it('leaves a result untouched with nothing unread', () => {
    const outcome = { content: [{ type: 'text' as const, text: '{}' }] };
    expect(withUnreadFooter(outcome, null)).toBe(outcome);
    expect(withUnreadFooter(outcome, { count: 0, direct: 0, from: [] })).toBe(
      outcome
    );
  });

  it('appends the line and the count, keeping existing _meta', () => {
    const outcome = {
      content: [{ type: 'text' as const, text: '{}' }],
      _meta: { other: 1 },
    };
    const footed = withUnreadFooter(outcome, {
      count: 1,
      direct: 1,
      from: ['agent:a/x'],
    });
    expect(footed.content).toHaveLength(2);
    expect(footed._meta).toEqual({ other: 1, 'dispatch/unread': 1 });
  });
});

describe('fetchUnread', () => {
  let home: string;
  const saved = process.env.DISPATCH_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dispatch-unread-home-'));
    process.env.DISPATCH_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  it('reads nothing without a credential this process already holds', async () => {
    expect(await fetchUnread(home, 'test-client')).toBeNull();
  });
});
