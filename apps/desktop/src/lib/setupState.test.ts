import type { SetupReport } from '@dispatch-foo/core/browser';
import { beforeEach, expect, test } from 'bun:test';

import {
  autoCompleteAction,
  readSetupComplete,
  setupReportKey,
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

const okOn = (defaultProvider: string): SetupReport => ({
  ...rep('ok'),
  defaultProvider,
});

test('auto-completing onto a fallback agent also makes it the default', () => {
  expect(autoCompleteAction(okOn('codex'), 'claude')).toEqual({
    complete: true,
    setDefault: 'codex',
  });
});

test('auto-completing on the configured agent changes nothing', () => {
  expect(autoCompleteAction(okOn('claude'), 'claude')).toEqual({
    complete: true,
  });
});

test('a custom executor the catalog does not know is left alone', () => {
  expect(autoCompleteAction(okOn('claude'), 'my-wrapper')).toEqual({
    complete: true,
  });
});

test('a report with something to fix never completes', () => {
  expect(autoCompleteAction(rep('needs-action'), 'claude')).toEqual({
    complete: false,
  });
});

test('report keys differ per project', () => {
  expect(setupReportKey(4771)).not.toEqual(setupReportKey(4772));
});
