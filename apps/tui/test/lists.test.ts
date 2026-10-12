import type { InboxItem, Message, RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { comingIn, goingOut } from '../src/lists';

const run = (id: string, state: RunMeta['state'], updatedAt: string) =>
  ({
    id,
    state,
    updatedAt,
    taskId: `t-${id}`,
    taskTitle: `Task ${id}`,
  }) as RunMeta;

describe('goingOut', () => {
  test('live runs first, then the newest finished ones', () => {
    const got = goingOut([
      run('a', 'finished', '2026-10-12T08:00:00Z'),
      run('b', 'running', '2026-10-12T07:00:00Z'),
      run('c', 'failed', '2026-10-12T09:00:00Z'),
      run('d', 'awaiting-approval', '2026-10-12T06:00:00Z'),
    ]);
    expect(got.map((r) => r.id)).toEqual(['b', 'd', 'c', 'a']);
  });
});

describe('comingIn', () => {
  test('asks waiting on you, then open notes, each labelled', () => {
    const ask = {
      id: 'm-1',
      body: 'Which provider?\nmore detail',
      from: 'run:r-1',
    } as Message;
    const note = {
      id: 'i-1',
      text: 'cache the index',
      done: false,
      linkedTaskId: null,
      createdByRunId: 'r-2',
      created: '2026-10-12T09:00:00Z',
    } as InboxItem;
    const done = { ...note, id: 'i-2', done: true };
    expect(comingIn([ask], [note, done])).toEqual([
      { key: 'ask:m-1', kind: 'ask', label: 'Which provider?' },
      { key: 'note:i-1', kind: 'note', label: 'cache the index (agent)' },
    ]);
  });
});
