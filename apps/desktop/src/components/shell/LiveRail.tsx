import type { RunMeta } from '@dispatch/client';
import { Bot } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { OverseerSession } from '../../hooks/useOverseerSession';
import type { TaskTab } from '../../lib/appNav';
import { deriveFeedState } from '../../lib/feedState';
import { formatRelativeTimeFromIso } from '../../lib/format';
import { buildLiveRail } from '../../lib/liveRail';
import { OverseerChat } from '../chat/OverseerChat';
import { Button } from '@/ui/button';
import { StateDot } from '@/ui/chrome/StateDot';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';

// Which tab the section is on, persisted so reopening the sidebar lands back
// on whatever you were last looking at.
const LIVE_RAIL_TAB_STORAGE_KEY = 'dispatch:live-rail-tab';

type LiveRailTab = 'runs' | 'overseer';

function readStoredLiveRailTab(): LiveRailTab {
  if (typeof window === 'undefined') return 'runs';
  return window.localStorage.getItem(LIVE_RAIL_TAB_STORAGE_KEY) === 'overseer'
    ? 'overseer'
    : 'runs';
}

interface LiveRailProps {
  runs: RunMeta[];
  /** Everything waiting on a human — App's own `buildInbox` total, the same number the
   * Inbox page and sidebar badge show. */
  attentionCount: number;
  /** The App-mounted overseer session this section's Overseer tab renders — the same
   * object OverseerView gets, so both surfaces show one conversation. */
  overseer: OverseerSession;
  /** Whether dispatchd is up and the client is live. When it isn't, the Overseer
   * tab explains instead of rendering a composer whose first Ask would throw —
   * the same gate OverseerView applies with DaemonUnavailable. */
  daemonReady: boolean;
  /** Opens the full task view on a run's chat tab — `openTaskView` in App.tsx. */
  onOpenTask: (taskId: string, tab: TaskTab, runId?: string) => void;
  /** Navigates to the Inbox project view. */
  onOpenInbox: () => void;
  /** Opens the full Overseer page — where a collapsed sidebar's queued approval
   * must lead, since this section cannot expand the sidebar it lives in. */
  onOpenOverseer: () => void;
  /** Whether the sidebar hosting this section is collapsed to its icon-only strip. */
  collapsed: boolean;
}

/**
 * The live-agents section of the left sidebar (it was a standalone right-hand rail until the
 * shell consolidated on one rail), with a Runs | Overseer toggle at the top. Runs shows one row
 * per currently-running agent; Overseer is the same conversation as the full Overseer page,
 * rail-sized. The attention strip sits above both — it is the only part that comes and goes,
 * the one thing here that still asks for you. In the collapsed icon strip the section narrows
 * to the essentials: the attention count, a queued overseer approval, and that agents are
 * running at all.
 */
export function LiveRail({
  runs,
  attentionCount,
  overseer,
  daemonReady,
  onOpenTask,
  onOpenInbox,
  onOpenOverseer,
  collapsed,
}: LiveRailProps) {
  const live = useMemo(() => buildLiveRail(runs), [runs]);

  const [tab, setTab] = useState<LiveRailTab>(readStoredLiveRailTab);
  useEffect(() => {
    window.localStorage.setItem(LIVE_RAIL_TAB_STORAGE_KEY, tab);
  }, [tab]);

  // The overseer mid-turn is an agent at work like any run — it earns a Runs-tab
  // row. `recordError` only decides the no-record case: fetch never succeeded
  // (stale id 404s, retry: false) means a broken conversation, not a turn in
  // flight. With a record cached, react-query keeps it through *background*
  // refetch errors, and a running record plus one transient failure is still
  // the overseer at work — dropping the row there would flicker on every blip.
  const overseerTurnLive =
    overseer.conversationId !== null &&
    (overseer.record === undefined
      ? overseer.recordError === null
      : overseer.record.state === 'running');
  // Mutations queued for the human, plus built-in calls the running turn is
  // parked on. A settled turn with a pending action is idle, not running — so
  // this is a separate signal: the section must not go quiet while an
  // approval is stranded behind it.
  const overseerPendingCount =
    (overseer.record?.pendingActions.length ?? 0) +
    (overseer.record?.pendingApprovals.length ?? 0);
  // What the Runs-tab waiting row describes: a parked call first (the turn is
  // blocked on it right now), else the oldest queued action.
  const firstParked = overseer.record?.pendingApprovals[0];
  const firstPendingAction =
    firstParked !== undefined
      ? { summary: firstParked.summary, createdAt: firstParked.requestedAt }
      : overseer.record?.pendingActions[0];
  const overseerRow = overseerTurnLive || overseerPendingCount > 0;
  // What "agents running" means everywhere in this section: the run rows plus
  // a overseer turn in flight — the collapsed strip and the expanded Runs tab
  // must quote the same number.
  const runningCount = live.length + (overseerTurnLive ? 1 : 0);

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 pb-2">
        {attentionCount > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onOpenInbox}
            aria-label={`${attentionCount} waiting on you`}
            title={`${attentionCount} waiting on you`}
            className="bg-state-waiting/10 text-state-waiting size-6 rounded-md p-0 text-[11px] font-medium"
          >
            {attentionCount}
          </Button>
        )}
        {overseerPendingCount > 0 && (
          // A stranded approval must survive the collapse the same way the
          // attention count does. The icon strip cannot expand the sidebar it
          // lives in, so this leads to the full Overseer page instead.
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onOpenOverseer}
            aria-label={`${overseerPendingCount} action${overseerPendingCount === 1 ? '' : 's'} awaiting your approval`}
            title={`${overseerPendingCount} action${overseerPendingCount === 1 ? '' : 's'} awaiting your approval`}
            className="size-6 rounded-md bg-amber-500/10 p-0 text-[11px] font-medium text-amber-600 dark:text-amber-400"
          >
            {overseerPendingCount}
          </Button>
        )}
        {runningCount > 0 && (
          // The one thing the strip cannot drop: that agents are running at
          // all. A overseer turn counts — the expanded Runs tab gives it a row.
          <span
            className="flex flex-col items-center gap-1"
            title={`${runningCount} agent${runningCount === 1 ? '' : 's'} running`}
          >
            <StateDot state="working" pulse />
            <span className="dense-meta">{runningCount}</span>
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-2 pb-2">
      <span className="dense-label">Live agents</span>

      {/* One radix Tabs root over the whole column, not just the header: the
          triggers set aria-controls unconditionally, so the bodies have to be
          real TabsContent panels or that IDREF points at nothing. As role=tab
          the triggers also never collide with the sidebar's *button* named
          "Overseer". */}
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as LiveRailTab)}
        className="min-h-0 gap-2"
      >
        <TabsList aria-label="Live agents sections">
          <TabsTrigger value="runs" className="px-2 text-[12px]">
            Runs
          </TabsTrigger>
          <TabsTrigger value="overseer" className="px-2 text-[12px]">
            Overseer
            {overseerPendingCount > 0 && (
              // The queued-approval count follows the tab label so a user
              // parked on Runs still sees a mutation is waiting on them.
              <span className="rounded-full bg-amber-500/15 px-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                {overseerPendingCount}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {attentionCount > 0 && (
          // Inside the Tabs root but outside both panels: the strip is the
          // section's one always-on signal and must survive the Overseer tab too.
          <button
            type="button"
            onClick={onOpenInbox}
            className="bg-state-waiting/10 text-state-waiting shrink-0 rounded-md px-2 py-1.5 text-left text-[12px] font-medium"
          >
            {attentionCount} waiting on you →
          </button>
        )}

        <TabsContent
          value="runs"
          className="flex min-h-0 flex-col overflow-y-auto"
        >
          {live.length === 0 && !overseerRow ? (
            <p className="text-muted-foreground text-[12px]">
              No agents running.
            </p>
          ) : (
            <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
              {overseerRow && (
                // A overseer turn in flight sits with the agents it is one of —
                // and a queued approval keeps a waiting row here. The row
                // describes what actually needs you: the pending action's own
                // summary and queue time when one exists, the conversation's
                // opening prompt and start while it is merely thinking. Its
                // "task view" is this section's own Overseer tab.
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setTab('overseer')}
                  className="h-auto w-full justify-start gap-2 rounded-md px-1.5 py-1 text-left font-normal"
                >
                  <StateDot
                    state={firstPendingAction ? 'approve' : 'working'}
                    pulse={firstPendingAction === undefined}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {firstPendingAction?.summary ??
                      overseer.record?.prompt ??
                      'Overseer'}
                  </span>
                  <span className="dense-meta shrink-0 capitalize">
                    overseer
                  </span>
                  {overseer.record !== undefined && (
                    <span className="dense-meta shrink-0">
                      {formatRelativeTimeFromIso(
                        firstPendingAction?.createdAt ??
                          overseer.record.createdAt
                      )}
                    </span>
                  )}
                </Button>
              )}
              {live.map(({ run, kindLabel }) => {
                const state = deriveFeedState(run) ?? 'working';
                return (
                  <Button
                    key={run.id}
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => onOpenTask(run.taskId, 'chat', run.id)}
                    className="h-auto w-full justify-start gap-2 rounded-md px-1.5 py-1 text-left font-normal"
                  >
                    <StateDot state={state} pulse={state === 'working'} />
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      {run.taskTitle}
                    </span>
                    {/* The fleet under a run — live/total while any sub-agent is still going,
                        the total once they have all stopped: a row that says "agent" while
                        twelve sub-agents work underneath it undersells what is going on. */}
                    {run.subagents !== undefined && run.subagents.total > 0 && (
                      <span
                        className="dense-meta flex shrink-0 items-center gap-0.5 tabular-nums"
                        aria-label={
                          run.subagents.running > 0
                            ? `${run.subagents.running} of ${run.subagents.total} sub-agents running`
                            : `${run.subagents.total} sub-agents`
                        }
                      >
                        <Bot className="size-3" />
                        {run.subagents.running > 0
                          ? `${run.subagents.running}/${run.subagents.total}`
                          : run.subagents.total}
                      </span>
                    )}
                    <span className="dense-meta shrink-0 capitalize">
                      {kindLabel}
                    </span>
                    <span className="dense-meta shrink-0">
                      {formatRelativeTimeFromIso(run.createdAt)}
                    </span>
                  </Button>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent
          value="overseer"
          className="flex max-h-80 min-h-0 flex-col overflow-y-auto"
        >
          {daemonReady ? (
            // Unmounted while the Runs tab shows, like any other tab body:
            // the half-typed message that used to need a keep-alive wrapper
            // lives on the session, which outlives this section entirely.
            <OverseerChat overseer={overseer} compact />
          ) : (
            <p className="text-muted-foreground text-[12px]">
              The dispatch daemon isn't available, and the overseer needs it.
              The Overseer page has the details and a retry.
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
