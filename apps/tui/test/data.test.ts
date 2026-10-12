import { overseerKey } from '@dispatch/client';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';

import { applyEvent } from '../src/data';

// Seeds the caches the TUI keeps, then reports which ones an event marked stale.
function staleAfter(type: string, conversationId?: string): string[] {
  const qc = new QueryClient();
  const keys: Record<string, readonly unknown[]> = {
    decisions: ['tui', 1, 'decisions'],
    runs: ['tui', 1, 'runs'],
    tasks: ['tui', 1, 'tasks'],
    overseer: overseerKey(1, 'w-1'),
  };
  for (const k of Object.values(keys)) qc.setQueryData(k, {});
  applyEvent(qc, 1, type, conversationId);
  return Object.entries(keys)
    .filter(([, k]) => qc.getQueryState(k)?.isInvalidated === true)
    .map(([name]) => name)
    .sort();
}

describe('applyEvent', () => {
  test('a new question, an answer or a feed change refreshes Coming in', () => {
    for (const type of [
      'message.new',
      'delivery.changed',
      'decisions.changed',
    ]) {
      expect(staleAfter(type)).toContain('decisions');
    }
  });

  test('a reconnect refreshes everything, the Overseer record included', () => {
    expect(staleAfter('hello')).toEqual([
      'decisions',
      'overseer',
      'runs',
      'tasks',
    ]);
  });

  test('a run change refreshes runs and nothing it does not touch', () => {
    expect(staleAfter('run.changed')).toEqual(['runs']);
  });
});
