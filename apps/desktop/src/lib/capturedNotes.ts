import type { InboxItem } from '@dispatch/client';

/** Captures still waiting on a decision: not dismissed, not made into a task, newest first. */
export function openCaptures(inbox: readonly InboxItem[]): InboxItem[] {
  return inbox
    .filter((i) => !i.done && i.linkedTaskId === null)
    .sort((a, b) => b.created.localeCompare(a.created));
}
