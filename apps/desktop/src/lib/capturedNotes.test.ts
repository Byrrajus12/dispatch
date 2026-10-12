import type { InboxItem } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { openCaptures } from './capturedNotes';

const item = (over: Partial<InboxItem>): InboxItem => ({
  id: 'i-1',
  kind: 'note',
  text: 'a thought',
  done: false,
  linkedTaskId: null,
  createdByRunId: null,
  created: '2026-10-12T09:00:00Z',
  ...over,
});

describe('openCaptures', () => {
  test('keeps only open, unconverted items, newest first', () => {
    const got = openCaptures([
      item({ id: 'old', created: '2026-10-12T08:00:00Z' }),
      item({ id: 'done', done: true }),
      item({ id: 'converted', linkedTaskId: 't-1' }),
      item({ id: 'new', created: '2026-10-12T10:00:00Z' }),
    ]);
    expect(got.map((i) => i.id)).toEqual(['new', 'old']);
  });

  test('an empty inbox has nothing to show', () => {
    expect(openCaptures([])).toEqual([]);
  });
});
