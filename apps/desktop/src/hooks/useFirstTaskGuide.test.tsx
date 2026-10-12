import type { DraftRecord, RunMeta } from '@dispatch/client';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test } from 'bun:test';

import { readGuide } from '../lib/firstTaskGuide';
import { useFirstTaskGuide } from './useFirstTaskGuide';

const NO_DRAFTS: DraftRecord[] = [];
const NO_TASKS: { meta: { id: string } }[] = [];
const NO_RUNS: RunMeta[] = [];
const ONE_TASK = [{ meta: { id: 't-1' } }];
const LANDED = [
  {
    id: 'r-1',
    taskId: 't-1',
    executor: 'claude',
    state: 'finished',
    reviewedAt: '2026-10-11T01:00:00.000Z',
    reviewAction: 'merge',
    createdAt: '2026-10-11T00:00:00.000Z',
  } as RunMeta,
];

function props(over: Partial<Parameters<typeof useFirstTaskGuide>[0]> = {}) {
  return {
    projectPath: '/p/a',
    enabled: true,
    projectEmpty: true,
    drafts: NO_DRAFTS,
    tasks: NO_TASKS,
    runs: NO_RUNS,
    ...over,
  };
}

beforeEach(() => window.localStorage.clear());

test('a fresh, empty project starts the guide at Describe it', () => {
  const { result } = renderHook(() => useFirstTaskGuide(props()));
  expect(result.current.view?.stage).toBe('describe');
  expect(readGuide('/p/a')).toEqual({ status: 'active' });
});

test('a project that already has tasks never starts it on its own', () => {
  const { result } = renderHook(() =>
    useFirstTaskGuide(props({ projectEmpty: false, tasks: ONE_TASK }))
  );
  expect(result.current.view).toBeNull();
  expect(readGuide('/p/a')).toBeNull();
});

test('nothing starts before Setup is done', () => {
  renderHook(() => useFirstTaskGuide(props({ enabled: false })));
  expect(readGuide('/p/a')).toBeNull();
});

test('dismissing keeps it gone for this project', () => {
  const first = renderHook(() => useFirstTaskGuide(props()));
  act(() => first.result.current.dismiss());
  expect(first.result.current.view).toBeNull();
  first.unmount();
  const again = renderHook(() => useFirstTaskGuide(props()));
  expect(again.result.current.view).toBeNull();
});

test('landing completes it: the completion shows once, then it stays gone', () => {
  window.localStorage.setItem(
    'dispatch:first-task-guide:/p/a',
    JSON.stringify({ status: 'active', taskId: 't-1' })
  );
  const landed = props({ projectEmpty: false, tasks: ONE_TASK, runs: LANDED });
  const first = renderHook(() => useFirstTaskGuide(landed));
  expect(first.result.current.view?.stage).toBe('done');
  expect(readGuide('/p/a')?.status).toBe('completed');
  act(() => first.result.current.closeCompletion());
  expect(first.result.current.view).toBeNull();
  first.unmount();
  expect(
    renderHook(() => useFirstTaskGuide(landed)).result.current.view
  ).toBeNull();
});

test("switching projects reads that project's guide; nothing leaks across", () => {
  const { result, rerender } = renderHook((p) => useFirstTaskGuide(p), {
    initialProps: props(),
  });
  expect(result.current.view?.stage).toBe('describe');
  rerender(
    props({ projectPath: '/p/b', projectEmpty: false, tasks: ONE_TASK })
  );
  expect(result.current.view).toBeNull();
  expect(readGuide('/p/b')).toBeNull();
  rerender(props());
  expect(result.current.view?.stage).toBe('describe');
});

test('a linked draft and task, collapsed and send error stay with their own project', () => {
  const { result, rerender } = renderHook((p) => useFirstTaskGuide(p), {
    initialProps: props(),
  });
  act(() => {
    result.current.linkDraft('d-1');
    result.current.setCollapsed(true);
    result.current.setSendError('boom');
  });
  expect(result.current.draftId).toBe('d-1');
  rerender(props({ projectPath: '/p/b' }));
  expect(result.current.draftId).toBeUndefined();
  expect(result.current.collapsed).toBe(false);
  expect(result.current.sendError).toBeNull();
  expect(readGuide('/p/b')).toEqual({ status: 'active' });
  rerender(props());
  expect(result.current.draftId).toBe('d-1');
  expect(readGuide('/p/a')).toEqual({ status: 'active', draftId: 'd-1' });
});

test("a dismissed project does not hide another empty project's guide", () => {
  const { result, rerender } = renderHook((p) => useFirstTaskGuide(p), {
    initialProps: props(),
  });
  act(() => result.current.dismiss());
  expect(result.current.view).toBeNull();
  rerender(props({ projectPath: '/p/b' }));
  expect(result.current.view?.stage).toBe('describe');
  expect(readGuide('/p/a')).toEqual({ status: 'dismissed' });
});

test('a null project path starts and writes nothing', () => {
  const { result } = renderHook(() =>
    useFirstTaskGuide(props({ projectPath: null }))
  );
  expect(result.current.view).toBeNull();
  expect(window.localStorage.length).toBe(0);
});

test('Restart brings a dismissed guide back to the start', () => {
  window.localStorage.setItem(
    'dispatch:first-task-guide:/p/a',
    JSON.stringify({ status: 'dismissed', taskId: 't-1' })
  );
  const { result } = renderHook(() =>
    useFirstTaskGuide(props({ projectEmpty: false, tasks: ONE_TASK }))
  );
  expect(result.current.view).toBeNull();
  act(() => result.current.restart());
  expect(result.current.view?.stage).toBe('describe');
  expect(readGuide('/p/a')).toEqual({ status: 'active' });
});

test('linking a task moves the guide to Check the plan', () => {
  const { result, rerender } = renderHook((p) => useFirstTaskGuide(p), {
    initialProps: props(),
  });
  act(() => result.current.linkTask('t-1'));
  rerender(props({ projectEmpty: false, tasks: ONE_TASK }));
  expect(result.current.view).toEqual({ stage: 'check', taskId: 't-1' });
});
