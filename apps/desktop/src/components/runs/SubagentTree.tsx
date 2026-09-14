import type { SubagentNode, SubagentTreeNode } from '@dispatch/core/browser';
import { flattenSubagentTree, nestSubagents } from '@dispatch/core/browser';
import { Bot, ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';

import { cn } from '@/lib/utils';
import { formatElapsed } from '@/ui/ai/use-elapsed';
import { StateDot } from '@/ui/chrome/StateDot';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/collapsible';
import type { FeedState } from '@/ui/lib/feedState';

/** How a sub-agent's status reads as a feed state, so its dot matches every other run's. */
function dotState(status: SubagentNode['status']): FeedState {
  switch (status) {
    case 'running':
      return 'working';
    case 'failed':
    case 'stopped':
      return 'failed';
    default:
      return 'ready';
  }
}

function statusWord(status: SubagentNode['status']): string {
  switch (status) {
    case 'running':
      return 'running';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      return 'done';
  }
}

/** The header's one-line account: "3 of 12 running · 2 failed", or "10 done · 2 failed". */
export function subagentHeadline(nodes: readonly SubagentNode[]): string {
  const running = nodes.filter((n) => n.status === 'running').length;
  const broken = nodes.filter(
    (n) => n.status === 'failed' || n.status === 'stopped'
  ).length;
  const head =
    running > 0
      ? `${running} of ${nodes.length} running`
      : `${nodes.length - broken} done`;
  return broken > 0 ? `${head} · ${broken} failed` : head;
}

/** A sub-agent's elapsed time: its reported duration, else its own clock while it runs. */
function elapsedFor(node: SubagentNode, now: number): string | null {
  if (node.durationMs !== undefined) return formatElapsed(node.durationMs);
  const start = Date.parse(node.startedAt);
  if (Number.isNaN(start)) return null;
  const end = node.finishedAt !== undefined ? Date.parse(node.finishedAt) : now;
  return formatElapsed(end - start);
}

/**
 * The sub-agents a run's agent fanned out into, as an indented tree above the
 * transcript. One row per sub-agent: status dot, what it was asked to do, its
 * type, how many tool calls it has made, how long it has run, and either what
 * it is doing right now (a progress summary or its last tool) or how it
 * ended. Collapsible because a run with thirty sub-agents would otherwise
 * push its own transcript below the fold; it opens with the run and remembers
 * the toggle for the view's life.
 */
export function SubagentTree({
  nodes,
  className,
}: {
  nodes: readonly SubagentNode[];
  className?: string;
}) {
  const [open, setOpen] = useState(true);
  const rows = useMemo(
    () => flattenSubagentTree(nestSubagents(nodes)),
    [nodes]
  );
  if (nodes.length === 0) return null;
  const now = Date.now();
  const anyRunning = nodes.some((n) => n.status === 'running');

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        'border-border bg-card/60 flex flex-col rounded-md border',
        className
      )}
      data-testid="subagent-tree"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="hover:bg-muted/50 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left"
          aria-label={`Sub-agents: ${subagentHeadline(nodes)}`}
        >
          {open ? (
            <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <Bot className="text-muted-foreground size-3.5 shrink-0" />
          <span className="text-[12px] font-medium">
            Sub-agents · {nodes.length}
          </span>
          <span
            className={cn(
              'dense-meta ml-auto shrink-0',
              anyRunning && 'text-foreground'
            )}
          >
            {subagentHeadline(nodes)}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul
          role="tree"
          aria-label="Sub-agents"
          className="border-border/60 flex max-h-56 flex-col overflow-y-auto border-t py-1"
        >
          {rows.map((row) => (
            <SubagentRow key={row.id} node={row} now={now} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SubagentRow({ node, now }: { node: SubagentTreeNode; now: number }) {
  const state = dotState(node.status);
  const elapsed = elapsedFor(node, now);
  // What the row says after the facts: the live summary while running (or the
  // last tool as a stand-in), the report once it ended.
  const tail =
    node.status === 'running'
      ? (node.summary ??
        (node.lastTool !== undefined ? `using ${node.lastTool}` : null))
      : node.summary;
  return (
    <li
      role="treeitem"
      aria-level={node.depth + 1}
      aria-label={`${node.label}, ${statusWord(node.status)}`}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-2.5 py-1 text-[12px]"
      style={{ paddingLeft: `${10 + node.depth * 16}px` }}
    >
      <span className="flex min-w-0 items-center gap-2">
        <StateDot state={state} pulse={node.status === 'running'} />
        <span className="min-w-0 truncate" title={node.label}>
          {node.label}
        </span>
        {node.type !== undefined && (
          <span className="dense-meta shrink-0">{node.type}</span>
        )}
      </span>
      <span className="dense-meta flex shrink-0 items-center gap-2 tabular-nums">
        <span>
          {node.toolUses} {node.toolUses === 1 ? 'call' : 'calls'}
        </span>
        {elapsed !== null && <span>{elapsed}</span>}
        <span
          className={cn(
            'w-14 text-right',
            (node.status === 'failed' || node.status === 'stopped') &&
              'text-state-failed'
          )}
        >
          {statusWord(node.status)}
        </span>
      </span>
      {tail !== undefined && tail !== null && tail !== '' && (
        <span
          className="text-muted-foreground col-span-2 truncate pl-5 text-[11px]"
          title={tail}
        >
          {tail}
        </span>
      )}
    </li>
  );
}
