import type { SubagentSummary } from '@dispatch/client';

/**
 * A run's fan-out in a few words for a list row: "3/12 agents live" while any
 * sub-agent is still running, "12 agents" once they have all come to rest,
 * with failures appended ("12 agents · 2 failed") because a failed sub-agent
 * is the one thing worth noticing in a scan. `null` for a run that never
 * fanned out, so callers can leave the slot alone rather than print zero.
 */
export function subagentSummaryLabel(
  summary: SubagentSummary | undefined
): string | null {
  if (summary === undefined || summary.total === 0) return null;
  const noun = summary.total === 1 ? 'agent' : 'agents';
  const head =
    summary.running > 0
      ? `${summary.running}/${summary.total} ${noun} live`
      : `${summary.total} ${noun}`;
  const broken = summary.failed + summary.stopped;
  return broken > 0 ? `${head} · ${broken} failed` : head;
}

/**
 * The same figures as a sentence for a row's activity column, where the
 * subject is understood: "3 of 12 sub-agents running", "12 sub-agents done,
 * 2 failed".
 */
export function subagentActivity(
  summary: SubagentSummary | undefined
): string | null {
  if (summary === undefined || summary.total === 0) return null;
  const noun = summary.total === 1 ? 'sub-agent' : 'sub-agents';
  const broken = summary.failed + summary.stopped;
  if (summary.running > 0) {
    const head = `${summary.running} of ${summary.total} ${noun} running`;
    return broken > 0 ? `${head}, ${broken} failed` : head;
  }
  const head = `${summary.total} ${noun} done`;
  return broken > 0 ? `${head}, ${broken} failed` : head;
}
