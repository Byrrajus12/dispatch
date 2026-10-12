import type { InboxItem } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { CapturedNotes } from './CapturedNotes';

const note = (over: Partial<InboxItem>): InboxItem => ({
  id: 'i-1',
  kind: 'note',
  text: 'rate limit the webhook',
  done: false,
  linkedTaskId: null,
  createdByRunId: null,
  created: '2026-10-12T09:00:00Z',
  ...over,
});

test('lists notes and routes Make task and Dismiss by id', () => {
  const made: string[][] = [];
  const dismissed: string[][] = [];
  render(
    <CapturedNotes
      items={[note({})]}
      onMakeTask={async (ids) => {
        made.push(ids);
      }}
      onDismiss={async (ids) => {
        dismissed.push(ids);
      }}
    />
  );
  expect(screen.getByText('rate limit the webhook')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Make task' }));
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(made).toEqual([['i-1']]);
  expect(dismissed).toEqual([['i-1']]);
});

test("marks an agent's note so it reads apart from your own", () => {
  render(
    <CapturedNotes
      items={[note({ createdByRunId: 'r-9' })]}
      onMakeTask={async () => {}}
      onDismiss={async () => {}}
    />
  );
  expect(screen.getByText('agent')).toBeDefined();
});

test('a note that arrives later shows on re-render', () => {
  const props = { onMakeTask: async () => {}, onDismiss: async () => {} };
  const { rerender } = render(<CapturedNotes items={[]} {...props} />);
  expect(screen.queryByTestId('captured-notes')).toBeNull();
  rerender(
    <CapturedNotes items={[note({ text: 'mid-run note' })]} {...props} />
  );
  expect(screen.getByText('mid-run note')).toBeDefined();
});
