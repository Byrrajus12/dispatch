import type { SetupReport } from '@dispatch-foo/core/browser';
import { beforeEach, expect, test } from 'bun:test';

import {
  readSetupComplete,
  shouldAutoComplete,
  writeSetupComplete,
} from './setupState';

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

const rep = (status: 'ok' | 'needs-action'): SetupReport => ({
  defaultProvider: null,
  providers: [],
  steps: [{ id: 'agent', status, message: 'm' }],
});

test('auto-completes only when the first report is all ok', () => {
  expect(shouldAutoComplete(rep('ok'))).toBe(true);
  expect(shouldAutoComplete(rep('needs-action'))).toBe(false);
});
