import type { RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { mergePendingApprovals } from './pendingApprovals';

function run(id: string, overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    id,
    taskId: `t-${id}`,
    taskTitle: `Task ${id}`,
    executor: 'fake',
    state: 'awaiting-approval',
    branch: `dispatch/${id}`,
    baseBranch: 'main',
    worktreePath: `/wt/${id}`,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:01:00.000Z',
    ...overrides,
  };
}

describe('mergePendingApprovals', () => {
  // The reload case: nothing was seen live, the run read alone must be enough
  // to put an Approve button back in front of the human.
  test('a parked run is answerable from the run read alone', () => {
    const merged = mergePendingApprovals(
      [run('a', { pendingApproval: { requestId: 'req-1', toolName: 'Bash' } })],
      new Map()
    );
    expect(merged.get('a')).toEqual({ requestId: 'req-1', toolName: 'Bash' });
  });

  test('the run read wins over a live entry for the same run', () => {
    const merged = mergePendingApprovals(
      [run('a', { pendingApproval: { requestId: 'req-2', toolName: 'Bash' } })],
      new Map([['a', { requestId: 'req-1', toolName: 'Bash' }]])
    );
    expect(merged.get('a')?.requestId).toBe('req-2');
  });

  // Between the WS event and the refetch it triggers, the run list still says
  // 'running' — the live entry must not be dropped in that window.
  test('a live entry fills in until the refetch carries the request', () => {
    const merged = mergePendingApprovals(
      [run('a', { state: 'awaiting-approval' })],
      new Map([['a', { requestId: 'req-1', toolName: 'Edit' }]])
    );
    expect(merged.get('a')).toEqual({ requestId: 'req-1', toolName: 'Edit' });
  });

  test('a run that is no longer awaiting approval contributes nothing', () => {
    const merged = mergePendingApprovals(
      [
        run('a', {
          state: 'finished',
          pendingApproval: { requestId: 'stale', toolName: 'Bash' },
        }),
      ],
      new Map([['a', { requestId: 'stale', toolName: 'Bash' }]])
    );
    expect(merged.size).toBe(0);
  });

  test('before the first run list arrives, live entries stand on their own', () => {
    const merged = mergePendingApprovals(
      undefined,
      new Map([['a', { requestId: 'req-1', toolName: 'Bash' }]])
    );
    expect(merged.get('a')?.requestId).toBe('req-1');
  });
});
