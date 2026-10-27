import type { Message } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { Post } from '../../lib/posts';
import { ForYouPosts } from './ForYouPosts';

function post(key: string, from: string, unread: boolean): Post {
  const latest: Message = {
    id: `m-${key}`,
    thread: key,
    replyTo: null,
    from,
    to: ['human:me'],
    kind: 'message',
    body: `About ${key}`,
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-10-26T19:17:00Z',
  };
  return {
    key,
    subject: key,
    kind: 'for-you',
    latest,
    count: 1,
    unread,
    deliveries: [],
  };
}

// Runs resolve to their task title, as App's addressName does.
const label = (address: string) =>
  address === 'run:r-1' ? 'Ship the thing' : address.replace(/^human:/, '');

function renderPosts(
  posts: Post[],
  handlers: {
    onDismiss?: (post: Post) => void;
    onClearAll?: (posts: readonly Post[]) => void;
  } = {}
) {
  return render(
    <ForYouPosts
      posts={posts}
      label={label}
      onOpen={() => {}}
      onReply={async () => {}}
      onDismiss={handlers.onDismiss ?? (() => {})}
      onClearAll={handlers.onClearAll ?? (() => {})}
      holding={false}
    />
  );
}

test('a run posting about itself reads as its task title, once', () => {
  renderPosts([post('run:r-1', 'run:r-1', false)]);
  const row = screen.getByTestId('for-you-post-read');
  expect(row.textContent).toContain('Ship the thing');
  expect(row.textContent).not.toContain('r-1');
  expect(row.textContent).not.toContain(' on ');
});

test('read and unread posts each dismiss on their own', () => {
  const dismissed: string[] = [];
  renderPosts(
    [post('run:r-1', 'run:r-1', false), post('task:t-2', 'human:ana', true)],
    { onDismiss: (p) => dismissed.push(p.key) }
  );
  const buttons = screen.getAllByTestId('for-you-post-dismiss');
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[0]);
  fireEvent.click(buttons[1]);
  expect(dismissed).toEqual(['run:r-1', 'task:t-2']);
});

test('Clear all hands over every post showing', () => {
  let cleared: readonly Post[] = [];
  renderPosts(
    [post('run:r-1', 'run:r-1', false), post('task:t-2', 'human:ana', true)],
    { onClearAll: (p) => (cleared = p) }
  );
  fireEvent.click(screen.getByTestId('for-you-clear-all'));
  expect(cleared.map((p) => p.key)).toEqual(['run:r-1', 'task:t-2']);
});
