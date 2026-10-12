import { expect, test } from 'bun:test';

import { GLOSSARY } from './glossary';

// Setup and guide surfaces never use these words (spec §2 copy rules).
const BANNED = /dispatchd|\.dispatch\/|tracker|worktree|executor/i;

test('every term is one plain sentence', () => {
  for (const [term, definition] of Object.entries(GLOSSARY)) {
    expect({ term, ok: /^[A-Z][^.]*\.$/.test(definition) }).toEqual({
      term,
      ok: true,
    });
  }
});

test('no definition uses a word the copy rules ban', () => {
  for (const [term, definition] of Object.entries(GLOSSARY)) {
    expect({ term, banned: BANNED.test(definition) }).toEqual({
      term,
      banned: false,
    });
  }
});
