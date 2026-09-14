import type { RunMeta } from '@dispatch/client';

/** The approval a run is parked on, as the UI needs it: enough to answer it
 * and to say which tool call is being asked about. */
export interface PendingApproval {
  requestId: string;
  toolName: string;
  /** The tool call's input, when the source carried it. */
  input?: unknown;
}

/**
 * Every approval this window can currently answer, keyed by run id. Two
 * sources feed it: the `approval.requested` WS events the window saw live,
 * and the `pendingApproval` the daemon attaches to each awaiting-approval run
 * in `GET /api/runs`. The run read is the daemon's present truth and wins
 * when both name the same run — a live entry can predate a newer request on
 * that run, and the daemon refuses a stale id — while the live map covers the
 * gap between the event and the refetch it triggers. A run that is no longer
 * awaiting approval contributes nothing from either source; before the first
 * run list has arrived, the live events are all there is to go on.
 */
export function mergePendingApprovals(
  runs: readonly RunMeta[] | undefined,
  live: ReadonlyMap<string, PendingApproval>
): Map<string, PendingApproval> {
  const merged = new Map<string, PendingApproval>();
  const awaiting = new Set<string>();
  for (const run of runs ?? []) {
    if (run.state !== 'awaiting-approval') continue;
    awaiting.add(run.id);
    if (run.pendingApproval !== undefined) {
      merged.set(run.id, run.pendingApproval);
    }
  }
  for (const [runId, approval] of live) {
    if (runs !== undefined && !awaiting.has(runId)) continue;
    if (!merged.has(runId)) merged.set(runId, approval);
  }
  return merged;
}
