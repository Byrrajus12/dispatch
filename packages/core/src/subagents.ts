// Sub-agents: the agents a run's own agent spawns (Claude Code's `Task` /
// `Agent` tool). A run's transcript records them as `kind: 'agent'` entries,
// one per lifecycle event, and this module folds those entries back into the
// tree of sub-agents a run fanned out into. It is pure and shared: dispatchd
// uses it to keep a per-run summary on RunMeta (and to rebuild that summary
// when it replays a transcript after a restart), and the desktop uses it to
// draw the tree from the same entries it already streams.

/** Where a sub-agent is in its life. `stopped` is a sub-agent a person or the
 * parent agent killed, as opposed to one that failed on its own. */
export type SubagentStatus = 'running' | 'done' | 'failed' | 'stopped';

/**
 * What one `kind: 'agent'` transcript entry says. `id` is the spawning
 * tool_use id, the one handle every event about the same sub-agent shares —
 * the executor correlates the SDK's own task ids back to it so readers never
 * have to. `phase` says which lifecycle edge this is; `status` is the
 * sub-agent's status as of this event.
 */
export interface SubagentEvent {
  id: string;
  phase: 'started' | 'progress' | 'finished';
  status: SubagentStatus;
  /** The task description the parent gave it. */
  label?: string;
  /** The `subagent_type` it was spawned as (`Explore`, `general-purpose`, …). */
  type?: string;
  /** Running totals the SDK reports on progress/finish. */
  toolUses?: number;
  tokens?: number;
  durationMs?: number;
  /** The tool the sub-agent most recently called, from a progress event. */
  lastTool?: string;
  /** A progress event's present-tense summary, or the final report's gist. */
  summary?: string;
}

/**
 * The slice of a transcript entry the fold reads. Structural on purpose so
 * the server's NormalizedEntry and the client's mirror of it both qualify
 * without either importing the other.
 */
export interface SubagentSourceEntry {
  ts: string;
  kind: string;
  /** Set on entries emitted from inside a sub-agent: the spawning tool_use id. */
  parentToolUseId?: string;
  agent?: SubagentEvent;
}

/** One sub-agent, folded from every event about it. */
export interface SubagentNode {
  id: string;
  /** The sub-agent that spawned this one, or `null` for the run's own agent. */
  parentId: string | null;
  label: string;
  type?: string;
  status: SubagentStatus;
  startedAt: string;
  finishedAt?: string;
  /** Tool calls seen from this sub-agent, or the SDK's own count if larger. */
  toolUses: number;
  tokens?: number;
  durationMs?: number;
  lastTool?: string;
  summary?: string;
}

/** The per-run counts RunMeta carries so lists can show fan-out without the transcript. */
export interface SubagentSummary {
  total: number;
  running: number;
  done: number;
  failed: number;
  stopped: number;
}

const TERMINAL_STATUSES: ReadonlySet<SubagentStatus> = new Set([
  'done',
  'failed',
  'stopped',
]);

/**
 * Applies one event's status on top of the status already known for that
 * sub-agent. A terminal status is final: a progress event that arrives after
 * the finish (the two come from different SDK streams and can cross) must not
 * flip a finished sub-agent back to running.
 */
export function nextSubagentStatus(
  current: SubagentStatus | undefined,
  event: Pick<SubagentEvent, 'status'>
): SubagentStatus {
  if (current !== undefined && TERMINAL_STATUSES.has(current)) return current;
  return event.status;
}

/**
 * Folds a run's entries into its sub-agents, in the order they were spawned.
 * Tool entries carrying `parentToolUseId` count toward that sub-agent's tool
 * calls, so a live tree ticks with every call even before the SDK reports a
 * total. Events about a sub-agent whose start was never recorded still create
 * a node (labelled by its id), so a transcript that begins mid-stream is
 * shown rather than dropped.
 */
export function foldSubagents(
  entries: readonly SubagentSourceEntry[]
): SubagentNode[] {
  const byId = new Map<string, SubagentNode>();
  const seenCalls = new Map<string, number>();
  for (const entry of entries) {
    if (entry.parentToolUseId !== undefined && entry.kind !== 'agent') {
      seenCalls.set(
        entry.parentToolUseId,
        (seenCalls.get(entry.parentToolUseId) ?? 0) + 1
      );
    }
    const event = entry.agent;
    if (entry.kind !== 'agent' || event === undefined) continue;
    // A sub-agent spawning another sub-agent shows up as the nested one's
    // start entry carrying the outer one's tool_use id, so that is the tree.
    if (entry.parentToolUseId !== undefined && event.phase === 'started') {
      seenCalls.set(
        entry.parentToolUseId,
        (seenCalls.get(entry.parentToolUseId) ?? 0) + 1
      );
    }
    let node = byId.get(event.id);
    if (node === undefined) {
      node = {
        id: event.id,
        parentId:
          entry.parentToolUseId !== undefined && byId.has(entry.parentToolUseId)
            ? entry.parentToolUseId
            : null,
        label: event.label ?? event.id,
        status: event.status,
        startedAt: entry.ts,
        toolUses: 0,
        ...(event.type !== undefined ? { type: event.type } : {}),
      };
      byId.set(event.id, node);
    } else {
      if (event.label !== undefined && node.label === node.id) {
        node.label = event.label;
      }
      if (event.type !== undefined && node.type === undefined) {
        node.type = event.type;
      }
      node.status = nextSubagentStatus(node.status, event);
    }
    if (event.phase === 'finished' && node.finishedAt === undefined) {
      node.finishedAt = entry.ts;
    }
    if (event.toolUses !== undefined && event.toolUses > node.toolUses) {
      node.toolUses = event.toolUses;
    }
    if (event.tokens !== undefined) node.tokens = event.tokens;
    if (event.durationMs !== undefined) node.durationMs = event.durationMs;
    if (event.lastTool !== undefined) node.lastTool = event.lastTool;
    if (event.summary !== undefined) node.summary = event.summary;
  }
  for (const node of byId.values()) {
    const seen = seenCalls.get(node.id) ?? 0;
    if (seen > node.toolUses) node.toolUses = seen;
  }
  return [...byId.values()];
}

/** Counts a folded list (or any status list) into the RunMeta summary. */
export function summarizeSubagents(
  statuses: Iterable<{ status: SubagentStatus }>
): SubagentSummary {
  const summary: SubagentSummary = {
    total: 0,
    running: 0,
    done: 0,
    failed: 0,
    stopped: 0,
  };
  for (const { status } of statuses) {
    summary.total += 1;
    summary[status] += 1;
  }
  return summary;
}

/** A folded node with its children attached, for rendering as a tree. */
export interface SubagentTreeNode extends SubagentNode {
  depth: number;
  children: SubagentTreeNode[];
}

/**
 * Nests a folded list by `parentId`, keeping spawn order within each level.
 * A node whose parent is missing (never recorded) is treated as a root rather
 * than lost.
 */
export function nestSubagents(
  nodes: readonly SubagentNode[]
): SubagentTreeNode[] {
  const treeById = new Map<string, SubagentTreeNode>();
  for (const node of nodes) {
    treeById.set(node.id, { ...node, depth: 0, children: [] });
  }
  const roots: SubagentTreeNode[] = [];
  for (const node of nodes) {
    const tree = treeById.get(node.id)!;
    const parent =
      node.parentId === null ? undefined : treeById.get(node.parentId);
    if (parent === undefined) {
      roots.push(tree);
    } else {
      tree.depth = parent.depth + 1;
      parent.children.push(tree);
    }
  }
  return roots;
}

/** Depth-first flattening of `nestSubagents`' output — one row per sub-agent, indented. */
export function flattenSubagentTree(
  roots: readonly SubagentTreeNode[]
): SubagentTreeNode[] {
  const out: SubagentTreeNode[] = [];
  const visit = (node: SubagentTreeNode): void => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return out;
}
