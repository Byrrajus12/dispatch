import { describe, expect, it } from 'bun:test';

import { subagentActivity, subagentSummaryLabel } from './subagentSummary';

const rest = { done: 0, failed: 0, stopped: 0 };

describe('subagentSummaryLabel', () => {
  it('says nothing for a run that never fanned out', () => {
    expect(subagentSummaryLabel(undefined)).toBeNull();
    expect(subagentSummaryLabel({ total: 0, running: 0, ...rest })).toBeNull();
  });

  it('counts live sub-agents against the total while any is running', () => {
    expect(
      subagentSummaryLabel({ total: 12, running: 3, ...rest, done: 9 })
    ).toBe('3/12 agents live');
  });

  it('gives the total once they have all stopped, naming failures', () => {
    expect(
      subagentSummaryLabel({ total: 1, running: 0, ...rest, done: 1 })
    ).toBe('1 agent');
    expect(
      subagentSummaryLabel({
        total: 12,
        running: 0,
        done: 9,
        failed: 2,
        stopped: 1,
      })
    ).toBe('12 agents · 3 failed');
  });
});

describe('subagentActivity', () => {
  it('reads as a sentence for the activity column', () => {
    expect(subagentActivity({ total: 12, running: 3, ...rest, done: 9 })).toBe(
      '3 of 12 sub-agents running'
    );
    expect(
      subagentActivity({
        total: 12,
        running: 3,
        done: 7,
        failed: 2,
        stopped: 0,
      })
    ).toBe('3 of 12 sub-agents running, 2 failed');
    expect(
      subagentActivity({ total: 4, running: 0, done: 3, failed: 1, stopped: 0 })
    ).toBe('4 sub-agents done, 1 failed');
    expect(subagentActivity(undefined)).toBeNull();
  });
});
