import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus, type ServerEvent } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import type { NormalizedEntry } from '../../src/orchestrator/types.js';
import { initGitRepo } from './helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo();
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

const HELLO: NormalizedEntry = {
  ts: '2026-10-25T10:00:00.000Z',
  kind: 'assistant',
  text: 'Hello',
  streamId: 'seg-1',
};

// A run that streams "Hello" into seg-1, waits for a message, logs the
// entry that finishes seg-1, starts seg-2, and waits again before finishing.
function streamingExecutor(): FakeExecutor {
  return new FakeExecutor({
    steps: [
      { delta: { segmentId: 'seg-1', text: 'Hel' } },
      { delta: { segmentId: 'seg-1', text: 'lo' }, awaitMessage: true },
      { entry: HELLO },
      { delta: { segmentId: 'seg-2', text: 'Bye' }, awaitMessage: true },
    ],
    finish: { state: 'finished', costUsd: 0, turns: 1 },
  });
}

function setUp(config?: string) {
  if (config !== undefined) {
    mkdirSync(join(repo, '.dispatch'), { recursive: true });
    writeFileSync(join(repo, '.dispatch', 'config.yml'), config);
  }
  const store = TaskStore.init(repo);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events,
  });
  orchestrator.registerExecutor('fake', streamingExecutor());
  const seen: ServerEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const task = store.create({ title: 'Say hello' });
  return { orchestrator, events, seen, taskId: task.meta.id };
}

function deltas(seen: ServerEvent[]) {
  return seen.flatMap((event) => (event.type === 'run.delta' ? [event] : []));
}

describe('a run streams its text live', () => {
  it('broadcasts each delta, serves the snapshot, and drops a segment once its entry lands', async () => {
    const { orchestrator, events, seen, taskId } = setUp();
    // What the snapshot held when each run.log went out: a reader told about
    // the entry must not also find its text live.
    const atLog: (string | undefined)[] = [];
    const run = await orchestrator.dispatch(taskId, 'fake');
    const unsubscribe = events.subscribe((event) => {
      if (event.type === 'run.log' && event.entry.streamId !== undefined) {
        atLog.push(
          orchestrator
            .liveText(run.id)
            ?.segments.map((s) => s.id)
            .join(',')
        );
      }
    });
    await waitFor(() => deltas(seen).length === 2);

    const [first, second] = deltas(seen);
    expect(first).toEqual({
      type: 'run.delta',
      runId: run.id,
      turnId: expect.any(String),
      seq: 1,
      segmentId: 'seg-1',
      text: 'Hel',
    });
    expect(second).toMatchObject({ seq: 2, turnId: first.turnId, text: 'lo' });
    expect(orchestrator.liveText(run.id)).toEqual({
      seq: 2,
      turnId: first.turnId,
      segments: [{ id: 'seg-1', text: 'Hello' }],
    });
    // The stored detail never carries the live text.
    expect('live' in (orchestrator.getRun(run.id) ?? {})).toBe(false);

    orchestrator.sendMessage(run.id, 'go on');
    await waitFor(() => deltas(seen).length === 3);
    expect(atLog).toEqual(['']);
    expect(orchestrator.liveText(run.id)).toEqual({
      seq: 3,
      turnId: first.turnId,
      segments: [{ id: 'seg-2', text: 'Bye' }],
    });
    expect(orchestrator.getRun(run.id)?.entries.at(-1)).toEqual(HELLO);

    orchestrator.sendMessage(run.id, 'finish');
    await waitFor(() => orchestrator.getRun(run.id)?.meta.state === 'finished');
    expect(orchestrator.liveText(run.id)).toBeUndefined();
    unsubscribe();
  });

  // Parity with run.log from onEntry, which reaches every socket today: the
  // live text of a run goes no further and no narrower than its log.
  it('sends run.delta to the same audience as the run.log of an entry', async () => {
    const { orchestrator, events, taskId } = setUp();
    const broadcast = spyOn(events, 'broadcast');
    const run = await orchestrator.dispatch(taskId, 'fake');
    await waitFor(() => orchestrator.liveText(run.id)?.seq === 2);
    orchestrator.sendMessage(run.id, 'go on');
    await waitFor(() => orchestrator.liveText(run.id)?.seq === 3);

    const audienceOf = (type: string) =>
      broadcast.mock.calls
        .filter(([event]) => event.type === type)
        .map(([, audience]) => audience);
    expect(audienceOf('run.delta')).toEqual([undefined, undefined, undefined]);
    expect(audienceOf('run.log').at(-1)).toBeUndefined();
    await orchestrator.cancel(run.id);
  });

  it('forgets the live text of a run cancelled mid-stream, logging none of it', async () => {
    const { orchestrator, taskId } = setUp();
    const run = await orchestrator.dispatch(taskId, 'fake');
    await waitFor(() => orchestrator.liveText(run.id)?.seq === 2);

    await orchestrator.cancel(run.id);
    expect(orchestrator.getRun(run.id)?.meta.state).toBe('cancelled');
    expect(orchestrator.liveText(run.id)).toBeUndefined();
    expect(orchestrator.getRun(run.id)?.entries).toEqual([]);
  });

  it('streams nothing under runs.stream: off, and still logs the entries', async () => {
    const { orchestrator, seen, taskId } = setUp('runs:\n  stream: off\n');
    const run = await orchestrator.dispatch(taskId, 'fake');
    await waitFor(() => orchestrator.getRun(run.id)?.meta.state === 'running');
    orchestrator.sendMessage(run.id, 'go on');
    await waitFor(
      () => orchestrator.getRun(run.id)?.entries.at(-1)?.text === 'Hello'
    );

    expect(deltas(seen)).toEqual([]);
    expect(orchestrator.liveText(run.id)).toBeUndefined();
    await orchestrator.cancel(run.id);
  });
});
