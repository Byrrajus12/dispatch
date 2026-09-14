import { describe, expect, it } from 'bun:test';

import {
  flattenSubagentTree,
  foldSubagents,
  nestSubagents,
  nextSubagentStatus,
  type SubagentSourceEntry,
  summarizeSubagents,
} from '../src/subagents.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';
const T2 = '2026-01-01T00:00:02.000Z';

function started(
  id: string,
  extra: Partial<SubagentSourceEntry['agent']> & {
    parentToolUseId?: string;
    ts?: string;
  } = {}
): SubagentSourceEntry {
  const { parentToolUseId, ts, ...agent } = extra;
  return {
    ts: ts ?? T0,
    kind: 'agent',
    ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
    agent: { id, phase: 'started', status: 'running', ...agent },
  };
}

describe('foldSubagents', () => {
  it('builds one node per sub-agent from its start, progress and finish', () => {
    const nodes = foldSubagents([
      started('tu-1', { label: 'Map the server', type: 'Explore' }),
      {
        ts: T1,
        kind: 'agent',
        agent: {
          id: 'tu-1',
          phase: 'progress',
          status: 'running',
          toolUses: 4,
          lastTool: 'Grep',
          summary: 'Reading the API routes',
        },
      },
      {
        ts: T2,
        kind: 'agent',
        agent: {
          id: 'tu-1',
          phase: 'finished',
          status: 'done',
          toolUses: 9,
          tokens: 12_000,
          durationMs: 8_000,
        },
      },
    ]);
    expect(nodes).toEqual([
      {
        id: 'tu-1',
        parentId: null,
        label: 'Map the server',
        type: 'Explore',
        status: 'done',
        startedAt: T0,
        finishedAt: T2,
        toolUses: 9,
        tokens: 12_000,
        durationMs: 8_000,
        lastTool: 'Grep',
        summary: 'Reading the API routes',
      },
    ]);
  });

  it('counts the tool calls a sub-agent made itself, until the SDK reports more', () => {
    const nodes = foldSubagents([
      started('tu-1', { label: 'a' }),
      { ts: T1, kind: 'tool', parentToolUseId: 'tu-1' },
      { ts: T1, kind: 'tool', parentToolUseId: 'tu-1' },
      { ts: T1, kind: 'tool' },
    ]);
    expect(nodes[0].toolUses).toBe(2);
    const reported = foldSubagents([
      started('tu-1', { label: 'a' }),
      { ts: T1, kind: 'tool', parentToolUseId: 'tu-1' },
      {
        ts: T2,
        kind: 'agent',
        agent: {
          id: 'tu-1',
          phase: 'progress',
          status: 'running',
          toolUses: 7,
        },
      },
    ]);
    expect(reported[0].toolUses).toBe(7);
  });

  it('nests a sub-agent spawned from inside another one, and counts it as a call', () => {
    const nodes = foldSubagents([
      started('outer', { label: 'outer' }),
      started('inner', { label: 'inner', parentToolUseId: 'outer', ts: T1 }),
    ]);
    expect(nodes.map((n) => [n.id, n.parentId])).toEqual([
      ['outer', null],
      ['inner', 'outer'],
    ]);
    expect(nodes[0].toolUses).toBe(1);
    const roots = nestSubagents(nodes);
    expect(roots).toHaveLength(1);
    expect(roots[0].children.map((c) => c.id)).toEqual(['inner']);
    expect(flattenSubagentTree(roots).map((n) => [n.id, n.depth])).toEqual([
      ['outer', 0],
      ['inner', 1],
    ]);
  });

  it('keeps a finish final when a late progress event crosses it', () => {
    const nodes = foldSubagents([
      started('tu-1', { label: 'a' }),
      {
        ts: T1,
        kind: 'agent',
        agent: { id: 'tu-1', phase: 'finished', status: 'failed' },
      },
      {
        ts: T2,
        kind: 'agent',
        agent: {
          id: 'tu-1',
          phase: 'progress',
          status: 'running',
          toolUses: 3,
        },
      },
    ]);
    expect(nodes[0].status).toBe('failed');
    expect(nodes[0].finishedAt).toBe(T1);
    expect(nextSubagentStatus('done', { status: 'running' })).toBe('done');
    expect(nextSubagentStatus(undefined, { status: 'running' })).toBe(
      'running'
    );
  });

  it('still shows a sub-agent whose start was never recorded', () => {
    const nodes = foldSubagents([
      {
        ts: T1,
        kind: 'agent',
        agent: { id: 'tu-9', phase: 'finished', status: 'done', label: 'late' },
      },
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].label).toBe('late');
    const unnamed = foldSubagents([
      {
        ts: T1,
        kind: 'agent',
        agent: { id: 'tu-9', phase: 'progress', status: 'running' },
      },
    ]);
    expect(unnamed[0].label).toBe('tu-9');
  });

  it('ignores every other entry kind', () => {
    expect(
      foldSubagents([
        { ts: T0, kind: 'assistant' },
        { ts: T0, kind: 'tool' },
        { ts: T0, kind: 'usage' },
      ])
    ).toEqual([]);
  });
});

describe('summarizeSubagents', () => {
  it('counts each status and the total', () => {
    expect(
      summarizeSubagents([
        { status: 'running' },
        { status: 'running' },
        { status: 'done' },
        { status: 'failed' },
        { status: 'stopped' },
      ])
    ).toEqual({ total: 5, running: 2, done: 1, failed: 1, stopped: 1 });
    expect(summarizeSubagents([])).toEqual({
      total: 0,
      running: 0,
      done: 0,
      failed: 0,
      stopped: 0,
    });
  });
});
