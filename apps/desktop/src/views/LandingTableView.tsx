import type { GateStatus, MergeQueueEntry } from '@dispatch/client';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { LandingRow } from '../components/landing/LandingRow';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { LandingFilters } from '../lib/landingView';
import {
  dedupeLandingRows,
  EMPTY_FILTERS,
  landedFromTasks,
  readLandingFilters,
  relativeTime,
  serializeLandingFilters,
  visibleLandingRows,
} from '../lib/landingView';
import { groupFailedAttempts } from '../lib/queueHistory';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/collapsible';
import { Input } from '@/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/table';

// Persists filters across launches, same key/shape Task 8's read/serialize
// pair round-trips — the only place that touches localStorage for them.
const FILTERS_STORAGE_KEY = 'dispatch:landing:filters';

function readStoredFilters(): LandingFilters {
  if (typeof window === 'undefined') return EMPTY_FILTERS;
  return readLandingFilters(window.localStorage.getItem(FILTERS_STORAGE_KEY));
}

interface LandingTableViewProps {
  data: DispatchProjectData;
  /** A run-backed row's title click — App.tsx opens the task's Diff tab. */
  onOpenRun: (taskId: string, runId: string) => void;
  /** A bare PR row's title click — App.tsx opens the PR review page. */
  onOpenPr: (number: number) => void;
}

/** The unified PR table: every run/PR/queue-local entry in flight, grouped by
 * what it needs, the queue's own verdict on anything it bounced ("Failed to
 * land", with a retry), plus a collapsible history of what recently landed. */
export function LandingTableView({
  data,
  onOpenRun,
  onOpenPr,
}: LandingTableViewProps) {
  const [filters, setFilters] = useState<LandingFilters>(readStoredFilters);
  useEffect(() => {
    window.localStorage.setItem(
      FILTERS_STORAGE_KEY,
      serializeLandingFilters(filters)
    );
  }, [filters]);

  const [landedOpen, setLandedOpen] = useState(false);
  const [staleOpen, setStaleOpen] = useState(false);
  const [pushRetrying, setPushRetrying] = useState(false);
  // The run a failed row is re-enqueueing, so its Retry reads busy while the
  // request is in flight. The outcome itself — the server's 409s (already
  // reviewed, already queued) and the "Queued to merge" confirmation — is
  // reported by the action-feedback wrapper around `data` (lib/actionFeedback.ts),
  // which is also why nothing here catches.
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);

  // Re-running "merge all ready" with nothing new to enqueue is what makes the
  // server retry a drain-push it failed. The banner clears on the next clean
  // `queue.drained`, not here.
  async function retryPush() {
    setPushRetrying(true);
    try {
      await data.handleMergeAllReady();
    } finally {
      setPushRetrying(false);
    }
  }

  // Re-enqueues one run the queue bounced — the same action as queueing it from
  // review, aimed at the run that fell out. Once the entry is live again the
  // failed row demotes to stale on its own (see `groupFailedAttempts`).
  async function retryFailed(runId: string) {
    setRetryingRunId(runId);
    try {
      await data.handleEnqueueMerge(runId);
    } finally {
      setRetryingRunId(null);
    }
  }

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }
  const client = data.client;

  const snapshot = data.landing;
  const now = Date.now();

  // Re-clicking the same author/gate a row's own buttons set clears it —
  // the dismissible chip above the table does the same thing in reverse.
  const toggleAuthor = (author: string) =>
    setFilters((f) => ({ ...f, author: f.author === author ? null : author }));
  const toggleGate = (gate: GateStatus) =>
    setFilters((f) => ({ ...f, gate: f.gate === gate ? null : gate }));
  const clearFilters = () => setFilters(EMPTY_FILTERS);
  // Narrowed locals so TS can carry the `!== null` check into the chips below.
  const authorFilter = filters.author;
  const gateFilter = filters.gate;
  const hasActiveFilters =
    filters.query !== '' || authorFilter !== null || gateFilter !== null;

  // One row per task — see `dedupeLandingRows`; the run map supplies recency.
  const deduped =
    snapshot !== null
      ? dedupeLandingRows(
          snapshot.rows,
          new Map(data.runs.map((r) => [r.id, r.createdAt]))
        )
      : null;
  const visibleRows =
    snapshot !== null && deduped !== null
      ? visibleLandingRows({ ...snapshot, rows: deduped.rows }, filters)
      : [];
  // Unfiltered, so a facet chip narrowing the visible rows never also hides
  // the entry `gateChipLabel` needs to name "behind <title>".
  const queueRows =
    snapshot !== null ? snapshot.rows.filter((r) => r.queue !== undefined) : [];
  // An all-local snapshot renders a page of dashes in the PR columns — they only earn
  // their width once a row actually has GitHub data.
  const showPrColumns =
    snapshot !== null && snapshot.rows.some((r) => r.pr !== undefined);
  const reviewedAtByRunId = new Map(
    data.runs
      .filter((r) => r.reviewedAt !== undefined)
      .map((r) => [r.id, r.reviewedAt])
  );
  // Durable across daemon restarts, unlike the queue's in-memory history — see
  // `landedFromTasks`.
  const landedTasks = landedFromTasks(data.tasksIncludingArchived);
  // The queue's verdicts on runs that fell out of it. Neither the snapshot's
  // rows (no failed gate) nor its landed list (merged history only) carry
  // these, so a run the queue bounced would otherwise sit in "Open" looking
  // untouched, its reason visible nowhere on this page. Same query as the live
  // entries, so the "back in the queue" rule can never see a stale pair.
  const { failed: failedAttempts, stale: staleAttempts } = groupFailedAttempts(
    data.mergeQueue?.history ?? [],
    data.runs,
    new Set((data.mergeQueue?.entries ?? []).map((e) => e.runId))
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-baseline gap-2">
        {/* react-query keeps the last snapshot on a failed refetch — this
            badge is the only thing that flags it as stale, not current. */}
        {snapshot !== null && data.landingIsError && (
          <Badge
            variant="outline"
            className="text-muted-foreground border-border"
          >
            stale · {relativeTime(snapshot.generatedAt, now)}
          </Badge>
        )}
      </div>

      {/* The one queue outcome nothing else reports. A drain that merges locally but fails
          to push leaves origin without the commit, while the rows below have already moved
          that entry into "Recently landed" — this is the only place that says otherwise. */}
      {data.lastPushError !== null && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-[12px]">
          <span className="min-w-0 truncate">
            Merged locally — push failed: {data.lastPushError}
          </span>
          <Button
            variant="secondary"
            size="xs"
            disabled={pushRetrying}
            onClick={() => void retryPush()}
          >
            Retry push
          </Button>
        </div>
      )}

      {snapshot === null && data.landingIsError ? (
        <EmptyState
          message="Couldn't load the PR table."
          action={
            <Button size="sm" variant="outline" onClick={data.landingRefetch}>
              Retry
            </Button>
          }
        />
      ) : snapshot === null ? (
        <p className="text-muted-foreground text-[12.5px]">
          Loading the PR table…
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={filters.query}
              onChange={(e) =>
                setFilters((f) => ({ ...f, query: e.target.value }))
              }
              placeholder="Search title, author, branch, or #123…"
              className="h-8 max-w-xs text-[12.5px]"
            />
            {authorFilter !== null && (
              <FilterChip
                label={`author: ${authorFilter}`}
                onDismiss={() => toggleAuthor(authorFilter)}
              />
            )}
            {gateFilter !== null && (
              <FilterChip
                label={`gate: ${gateFilter}`}
                onDismiss={() => toggleGate(gateFilter)}
              />
            )}
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="xs"
                onClick={clearFilters}
                className="text-muted-foreground hover:text-foreground h-auto px-1.5 py-1 text-[11.5px] font-normal"
              >
                Clear filters
              </Button>
            )}
          </div>

          {visibleRows.length === 0 ? (
            <EmptyState
              message={
                snapshot.rows.length === 0
                  ? 'Nothing in flight.'
                  : 'No rows match.'
              }
              action={
                hasActiveFilters ? (
                  <Button size="sm" variant="outline" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-6" />
                  <TableHead>Change</TableHead>
                  <TableHead>Lands</TableHead>
                  {showPrColumns && (
                    <TableHead className="hidden md:table-cell">
                      Checks
                    </TableHead>
                  )}
                  {showPrColumns && (
                    <TableHead className="hidden sm:table-cell">
                      Changes
                    </TableHead>
                  )}
                  <TableHead className="hidden md:table-cell">Review</TableHead>
                  {showPrColumns && <TableHead>Worktree</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((entry) =>
                  entry.type === 'group' ? (
                    <TableRow
                      key={`group-${entry.id}`}
                      className="hover:bg-transparent"
                    >
                      <TableCell
                        colSpan={showPrColumns ? 7 : 4}
                        className="bg-muted/20 py-1.5"
                      >
                        <span className="dense-label">{entry.label}</span>{' '}
                        <Badge variant="outline" className="ml-1">
                          {entry.count}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ) : (
                    <LandingRow
                      key={entry.row.id}
                      row={entry.row}
                      queueRows={queueRows}
                      now={now}
                      showPrColumns={showPrColumns}
                      extraRuns={
                        entry.row.taskId !== undefined
                          ? deduped?.extraRunsByTask.get(entry.row.taskId)
                          : undefined
                      }
                      reviewedAt={
                        entry.row.runId !== undefined
                          ? reviewedAtByRunId.get(entry.row.runId)
                          : undefined
                      }
                      onFilterAuthor={toggleAuthor}
                      onFilterGate={toggleGate}
                      onOpenRun={onOpenRun}
                      onOpenPr={onOpenPr}
                      client={client}
                      port={data.port}
                      onRetryQueue={data.handleRecheckMergeQueue}
                    />
                  )
                )}
              </TableBody>
            </Table>
          )}

          {failedAttempts.length > 0 && (
            <section className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2 px-1 py-1">
                <span className="dense-label">Failed to land</span>
                <Badge variant="outline">{failedAttempts.length}</Badge>
              </div>
              {failedAttempts.map((entry) => (
                <FailedAttemptRow
                  key={attemptKey(entry)}
                  entry={entry}
                  now={now}
                  retrying={retryingRunId === entry.runId}
                  retryDisabled={retryingRunId !== null}
                  onOpen={() => onOpenRun(entry.taskId, entry.runId)}
                  onRetry={() => void retryFailed(entry.runId)}
                />
              ))}
            </section>
          )}

          {/* Failures the run has outgrown — reviewed anyway, superseded by a newer
              attempt, or re-queued. Kept reachable, never as headline rows. */}
          {staleAttempts.length > 0 && (
            <Collapsible open={staleOpen} onOpenChange={setStaleOpen}>
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground hover:text-foreground h-auto w-fit px-1.5 py-1 text-[11.5px] font-normal"
                >
                  {staleOpen ? 'Hide' : 'Show'} {staleAttempts.length} stale{' '}
                  {staleAttempts.length === 1 ? 'attempt' : 'attempts'}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-1 flex flex-col gap-0.5">
                {staleAttempts.map((entry) => (
                  <div
                    key={attemptKey(entry)}
                    className="dense-meta flex items-center gap-1.5 truncate px-1 py-0.5"
                  >
                    <button
                      type="button"
                      onClick={() => onOpenRun(entry.taskId, entry.runId)}
                      className="text-foreground truncate hover:underline"
                    >
                      {entry.taskTitle}
                    </button>
                    <span>·</span>
                    <span className="min-w-0 truncate">
                      {entry.reason ?? 'failed'}
                    </span>
                    <span>·</span>
                    <span className="shrink-0">
                      {relativeTime(attemptFinishedAt(entry), now)}
                    </span>
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}

          <Collapsible open={landedOpen} onOpenChange={setLandedOpen}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground hover:text-foreground h-auto w-fit px-1.5 py-1 text-[11.5px] font-normal"
              >
                {landedOpen ? 'Hide' : 'Show'} recently landed (
                {landedTasks.length})
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1 flex flex-col gap-0.5">
              {landedTasks.length === 0 ? (
                <p className="text-muted-foreground text-[12.5px]">
                  Nothing has landed yet.
                </p>
              ) : (
                landedTasks.map((landed) => {
                  // The queue's own history enriches a row with how it landed,
                  // when this daemon session still remembers it.
                  const queueEntry = snapshot.landed.find(
                    (l) => l.title === landed.title
                  );
                  return (
                    <div
                      key={landed.id}
                      className="dense-meta flex items-center gap-1.5 truncate px-1 py-0.5"
                    >
                      <span className="text-foreground truncate">
                        {landed.title}
                      </span>
                      {queueEntry !== undefined && (
                        <>
                          <span>·</span>
                          <span>
                            {queueEntry.via === 'pr'
                              ? `via PR #${queueEntry.prNumber}`
                              : 'via local'}
                          </span>
                          {queueEntry.mergeCommit !== undefined && (
                            <>
                              <span>·</span>
                              <span>{queueEntry.mergeCommit.slice(0, 7)}</span>
                            </>
                          )}
                        </>
                      )}
                      <span>·</span>
                      <span>{relativeTime(landed.landedAt, now)}</span>
                    </div>
                  );
                })
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}
    </div>
  );
}

// A history entry's React key. A run can fail more than once, so the run id alone
// would collide across its stale attempts; the finish time tells them apart.
function attemptKey(entry: MergeQueueEntry): string {
  return `${entry.runId}-${entry.finishedAt ?? entry.enqueuedAt}`;
}

// When a history entry came to rest. `finishedAt` is set on every entry the
// server files to history; the fallbacks only cover entries persisted before
// the field existed.
function attemptFinishedAt(entry: MergeQueueEntry): string {
  return entry.finishedAt ?? entry.stateSince ?? entry.enqueuedAt;
}

/**
 * One failed queue attempt: the task, when it failed, a Retry that re-enqueues
 * the run, and the queue's failure reason in full. The reason is the row's whole
 * point — the phase it died in was never recorded (see `phaseSteps`), so the
 * message is the only specific thing there is. Tint stays on the reason, not
 * the row: a wall of red rows reads as alarm wallpaper, not information.
 */
function FailedAttemptRow({
  entry,
  now,
  retrying,
  retryDisabled,
  onOpen,
  onRetry,
}: {
  entry: MergeQueueEntry;
  now: number;
  retrying: boolean;
  retryDisabled: boolean;
  onOpen: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="hover:bg-muted/40 rounded-md px-3 py-2 transition-colors duration-150">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 truncate text-left text-[13px] hover:underline"
        >
          {entry.taskTitle}
        </button>
        <span className="dense-meta shrink-0">
          {relativeTime(attemptFinishedAt(entry), now)}
        </span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={retryDisabled}
          onClick={onRetry}
          aria-label={`Retry: ${entry.taskTitle}`}
          className="shrink-0"
        >
          {retrying ? 'Queuing…' : 'Retry'}
        </Button>
      </div>
      {/* Full text, wrapped — a verify log's useful line is usually its last. Height is
          capped so a reason at the server's 4 KB limit scrolls in place instead of
          pushing the rest of the page away. */}
      <p className="text-state-failed mt-1 max-h-32 overflow-y-auto text-[12px] break-words whitespace-pre-wrap">
        {entry.reason ?? 'failed'}
      </p>
    </div>
  );
}

function FilterChip({
  label,
  onDismiss,
}: {
  label: string;
  onDismiss: () => void;
}) {
  return (
    <Badge variant="secondary" className="gap-1 py-0.5 pr-1">
      {label}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={`Remove filter: ${label}`}
        className="hover:text-foreground rounded-full"
      >
        <X className="size-3" />
      </button>
    </Badge>
  );
}
