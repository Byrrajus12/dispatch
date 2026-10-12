import type { DraftRecord, RunMeta } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test } from 'bun:test';
import type { ReactNode } from 'react';

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
  expect(result.current.collapsed).toBeNull();
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

// Each project's task list under one key, as when a daemon port is reused: what the hook
// must tell apart is a list that arrived before the switch from one that arrived after.
const KEY = ['dispatch-tasks', 1] as const;
interface Step {
  path: string | null;
  ready: boolean;
  count: number;
}
const step = (
  path: string | null,
  over: Partial<Omit<Step, 'path'>> = {}
): Step => ({ path, ready: true, count: 0, ...over });

function setup() {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  // A list arriving at time `at`, the way a fetch updates the query.
  const arrive = (at: number) =>
    act(() => {
      queryClient.setQueryData(KEY, [], { updatedAt: at });
    });
  return { wrapper, arrive };
}

test('an empty project only counts once its own task list has loaded', () => {
  const { wrapper, arrive } = setup();
  const { result, rerender } = renderHook(
    ({ path, ready, count }: Step) =>
      useFreshEmptyProject(path, { ready, count, queryKey: KEY }),
    { wrapper, initialProps: step(null, { ready: false }) }
  );
  expect(result.current).toBe(false);
  // Cold start: the first project's list loading, then loaded and empty.
  rerender(step('/p/a', { ready: false }));
  expect(result.current).toBe(false);
  arrive(100);
  rerender(step('/p/a'));
  expect(result.current).toBe(true);
  // A switch: the list still showing is the one from before, so it does not count.
  rerender(step('/p/b'));
  expect(result.current).toBe(false);
  // The new project's list arrives with tasks in it.
  arrive(200);
  rerender(step('/p/b', { count: 3 }));
  expect(result.current).toBe(false);
  // Back to an empty project, once its list has been fetched again.
  rerender(step('/p/a', { count: 3 }));
  expect(result.current).toBe(false);
  arrive(300);
  rerender(step('/p/a'));
  expect(result.current).toBe(true);
  // Switching through no project at all (the new one still resolving) is still a switch.
  rerender(step(null, { ready: false }));
  expect(result.current).toBe(false);
  rerender(step('/p/b'));
  expect(result.current).toBe(false);
  arrive(400);
  rerender(step('/p/b', { count: 2 }));
  expect(result.current).toBe(false);
});

test('a list arriving after the switch is picked up without another render', () => {
  const { wrapper, arrive } = setup();
  arrive(100);
  const { result, rerender } = renderHook(
    ({ path, ready, count }: Step) =>
      useFreshEmptyProject(path, { ready, count, queryKey: KEY }),
    { wrapper, initialProps: step('/p/a') }
  );
  expect(result.current).toBe(true);
  rerender(step('/p/b'));
  expect(result.current).toBe(false);
  arrive(200);
  expect(result.current).toBe(true);
});

test('switching to a populated project never starts its guide, even mid-switch', () => {
  const { wrapper, arrive } = setup();
  arrive(100);
  const { result, rerender } = renderHook(
    ({ path, ready, count }: Step) => {
      const projectEmpty = useFreshEmptyProject(path, {
        ready,
        count,
        queryKey: KEY,
      });
      return useFirstTaskGuide(
        props({
          projectPath: path,
          projectEmpty,
          tasks: count > 0 ? ONE_TASK : NO_TASKS,
        })
      );
    },
    { wrapper, initialProps: step('/p/a') }
  );
  expect(readGuide('/p/a')).toEqual({ status: 'active' });
  // One render with the old (empty) list under the new project, then loading, then loaded.
  rerender(step('/p/b'));
  rerender(step('/p/b', { ready: false }));
  arrive(200);
  rerender(step('/p/b', { count: 1 }));
  expect(readGuide('/p/b')).toBeNull();
  expect(result.current.view).toBeNull();
});

test('a guide left at Describe steps aside once the project has tasks from elsewhere', () => {
  const { result, rerender } = renderHook((p) => useFirstTaskGuide(p), {
    initialProps: props(),
  });
  expect(result.current.view?.stage).toBe('describe');
  // A task made from the board or by the Overseer, not through the guide.
  rerender(props({ projectEmpty: false, tasks: ONE_TASK }));
  expect(result.current.view).toBeNull();
  // Still following, so a link that lands late is kept.
  expect(result.current.active).toBe(true);
  // Restart brings it back for this session, tasks and all.
  act(() => result.current.restart());
  expect(result.current.view?.stage).toBe('describe');
});

test('a guide at Describe on a project with tasks stays hidden on the next launch', () => {
  window.localStorage.setItem(
    'dispatch:first-task-guide:/p/a',
    JSON.stringify({ status: 'active' })
  );
  const { result } = renderHook(() =>
    useFirstTaskGuide(props({ projectEmpty: false, tasks: ONE_TASK }))
  );
  expect(result.current.view).toBeNull();
});

test('a guide waiting on its own draft stays up when other tasks appear', () => {
  const drafting = [{ id: 'd-1', state: 'running' } as DraftRecord];
  window.localStorage.setItem(
    'dispatch:first-task-guide:/p/a',
    JSON.stringify({ status: 'active', draftId: 'd-1' })
  );
  const { result } = renderHook(() =>
    useFirstTaskGuide(
      props({ projectEmpty: false, tasks: ONE_TASK, drafts: drafting })
    )
  );
  expect(result.current.view).toMatchObject({
    stage: 'describe',
    waiting: 'drafting',
  });
});
