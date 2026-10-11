import { beforeEach, expect, test } from 'bun:test';

import { readSetupComplete, writeSetupComplete } from './setupState';

beforeEach(() => window.localStorage.clear());

test('starts incomplete and remembers completion', () => {
  expect(readSetupComplete()).toBe(false);
  writeSetupComplete();
  expect(readSetupComplete()).toBe(true);
});

test('treats a mangled entry as incomplete', () => {
  window.localStorage.setItem('dispatch:setup-complete', '{nope');
  expect(readSetupComplete()).toBe(false);
});
