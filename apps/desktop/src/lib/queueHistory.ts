import type { MergeQueueEntry } from '@dispatch/client';

/**
 * Read model over the FAILED attempts in merge-queue history — the terminal entries
 * `GET /api/merge-queue` returns, as opposed to `mergeQueueView.ts`, which models the
 * live queue.
 *
 * A failed attempt leaves no other trace a list can show: the landing snapshot keeps
 * only merged history (packages/server/src/landing.ts), the feed indexes only live
 * queue entries (`controlRoom.ts`), and the run itself is just terminal and
 * unreviewed again. So a run the queue bounced reads as an ordinary needs-review run
 * everywhere unless these helpers put the queue's own verdict back beside it.
 */

/** What only the run list knows about a history entry's run: whether a human (or
 * the queue itself, on a later attempt) has since reviewed it. */
interface HistoryRunFacts {
  id: string;
  reviewedAt?: string;
}

interface FailedAttemptGroups {
  /** Failed attempts still worth a headline row: the run's latest attempt, and the
   * run has not been reviewed or re-queued since. Each is actionable — retry or
   * look. */
  failed: MergeQueueEntry[];
  /** Failed attempts the run has outgrown: reviewed anyway, superseded by a newer
   * attempt, or back in the live queue. Shown only behind a disclosure. */
  stale: MergeQueueEntry[];
}

/**
 * Splits the failed attempts in queue history (newest first, as the server sends it)
 * into live failures and stale ones. Merged entries are skipped: what landed is
 * already told by the task store and the landing snapshot.
 *
 * A failed attempt is stale when its failure no longer describes the run's present:
 * - the run's `reviewedAt` is set — it was merged, discarded, or PR'd despite the
 *   failure, or a later queue attempt landed it (a queue merge sets `reviewedAt` too);
 * - a newer history entry exists for the same run — that attempt, whatever its
 *   outcome, is the one that describes the run now;
 * - the run is back in the live queue (`queuedRunIds`) — the pending attempt is the
 *   story, and without this rule clicking a failed row's Retry would leave the
 *   failure up as if the retry never took.
 * A run absent from `runs` stays live: an empty or still-loading run list must not
 * silently reclassify every failure as stale.
 */
export function groupFailedAttempts(
  history: readonly MergeQueueEntry[],
  runs: readonly HistoryRunFacts[],
  queuedRunIds: ReadonlySet<string> = new Set()
): FailedAttemptGroups {
  const reviewed = new Set(
    runs.filter((r) => r.reviewedAt !== undefined).map((r) => r.id)
  );

  const failed: MergeQueueEntry[] = [];
  const stale: MergeQueueEntry[] = [];
  // Run ids already seen while walking newest→oldest — anything after the first
  // sighting is a superseded attempt. Merged entries count as sightings too: a
  // failure older than the merge that landed the run is exactly the stale case.
  const seen = new Set<string>();

  for (const entry of history) {
    const superseded = seen.has(entry.runId);
    seen.add(entry.runId);
    if (entry.state !== 'failed') continue;
    if (
      superseded ||
      reviewed.has(entry.runId) ||
      queuedRunIds.has(entry.runId)
    ) {
      stale.push(entry);
    } else {
      failed.push(entry);
    }
  }

  return { failed, stale };
}

/**
 * Each run's LATEST queue attempt, keyed by run id, kept only when that attempt
 * failed — what the Inbox's review rows check to carry a "failed to land" badge.
 * Latest is what matters: a run that failed once and then merged on retry is fine,
 * and badging it would re-tell the stale story the grouping above exists to bury.
 */
export function latestFailedAttemptByRunId(
  history: readonly MergeQueueEntry[]
): Map<string, MergeQueueEntry> {
  const latest = new Map<string, MergeQueueEntry>();
  // Newest first — the first entry seen per run is its latest attempt.
  for (const entry of history) {
    if (!latest.has(entry.runId)) latest.set(entry.runId, entry);
  }
  const failed = new Map<string, MergeQueueEntry>();
  for (const [runId, entry] of latest) {
    if (entry.state === 'failed') failed.set(runId, entry);
  }
  return failed;
}
