import type { DraftRecord, RunMeta } from '@dispatch/client';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test } from 'bun:test';

import { readGuide } from '../lib/firstTaskGuide';
import { useFirstTaskGuide, useFreshEmptyProject } from './useFirstTaskGuide';

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

test('Start over sets the pull request run aside and goes back to Check the plan', () => {
  window.localStorage.setItem(
    'dispatch:first-task-guide:/p/a',
    JSON.stringify({ status: 'active', taskId: 't-1' })
  );
  const pr = [
    {
      id: 'r-1',
      taskId: 't-1',
      executor: 'claude',
      state: 'finished',
      prUrl: 'https://github.com/o/r/pull/1',
      createdAt: '2026-10-11T00:00:00.000Z',
    } as RunMeta,
  ];
  const { result } = renderHook(() =>
    useFirstTaskGuide(props({ projectEmpty: false, tasks: ONE_TASK, runs: pr }))
  );
  expect(result.current.view?.stage).toBe('land');
  act(() => result.current.startOver('r-1'));
  expect(result.current.view).toEqual({ stage: 'check', taskId: 't-1' });
  expect(readGuide('/p/a')).toEqual({
    status: 'active',
    taskId: 't-1',
    setAsideRunId: 'r-1',
  });
});

type ListInput = Parameters<typeof useFreshEmptyProject>[1];
const list = (over: Partial<ListInput> = {}): ListInput => ({
  ready: true,
  fetchedAt: 100,
  count: 0,
  ...over,
});

test('an empty project only counts once its own task list has loaded', () => {
  const { result, rerender } = renderHook(
    ({ path, l }: { path: string | null; l: ListInput }) =>
      useFreshEmptyProject(path, l),
    {
      initialProps: {
        path: null as string | null,
        l: list({ ready: false, fetchedAt: 0 }),
      },
    }
  );
  expect(result.current).toBe(false);
  // Cold start: the first project's list loading, then loaded and empty.
  rerender({ path: '/p/a', l: list({ ready: false, fetchedAt: 0 }) });
  expect(result.current).toBe(false);
  rerender({ path: '/p/a', l: list() });
  expect(result.current).toBe(true);
  // A switch: the list still showing is the one from before, so it does not count.
  rerender({ path: '/p/b', l: list() });
  expect(result.current).toBe(false);
  // The new project's list arrives with tasks in it.
  rerender({ path: '/p/b', l: list({ fetchedAt: 200, count: 3 }) });
  expect(result.current).toBe(false);
  // Back to an empty project, once its list has been fetched again.
  rerender({ path: '/p/a', l: list({ fetchedAt: 200, count: 3 }) });
  expect(result.current).toBe(false);
  rerender({ path: '/p/a', l: list({ fetchedAt: 300 }) });
  expect(result.current).toBe(true);
  // Switching through no project at all (the new one still resolving) is still a switch.
  rerender({ path: null, l: list({ ready: false, fetchedAt: 0 }) });
  expect(result.current).toBe(false);
  rerender({ path: '/p/b', l: list({ fetchedAt: 300 }) });
  expect(result.current).toBe(false);
  rerender({ path: '/p/b', l: list({ fetchedAt: 400, count: 2 }) });
  expect(result.current).toBe(false);
});

test('switching to a populated project never starts its guide, even mid-switch', () => {
  const { result, rerender } = renderHook(
    ({ path, l }: { path: string; l: ListInput }) => {
      const projectEmpty = useFreshEmptyProject(path, l);
      return useFirstTaskGuide(
        props({
          projectPath: path,
          projectEmpty,
          tasks: l.count > 0 ? ONE_TASK : NO_TASKS,
        })
      );
    },
    { initialProps: { path: '/p/a', l: list() } }
  );
  expect(readGuide('/p/a')).toEqual({ status: 'active' });
  // One render with the old (empty) list under the new project, then loading, then loaded.
  rerender({ path: '/p/b', l: list() });
  rerender({ path: '/p/b', l: list({ ready: false }) });
  rerender({ path: '/p/b', l: list({ fetchedAt: 200, count: 1 }) });
  expect(readGuide('/p/b')).toBeNull();
  expect(result.current.view).toBeNull();
});
