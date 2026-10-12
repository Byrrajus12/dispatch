import type { InboxItem, Message, RunMeta } from '@dispatch/client';

const LIVE: ReadonlySet<RunMeta['state']> = new Set([
  'provisioning',
  'running',
  'awaiting-approval',
]);

/** Going out: live runs first, then settled ones; each group newest activity first. */
export function goingOut(runs: readonly RunMeta[]): RunMeta[] {
  const live = runs.filter((r) => LIVE.has(r.state));
  const settled = runs.filter((r) => !LIVE.has(r.state));
  return [
    ...live.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).reverse(),
    ...settled.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  ];
}

export interface InflowItem {
  key: string;
  kind: 'ask' | 'note';
  label: string;
}

/** Coming in: open asks waiting on you, then captured notes still undecided. */
export function comingIn(
  asks: readonly Message[],
  inbox: readonly InboxItem[]
): InflowItem[] {
  return [
    ...asks.map((m) => ({
      key: `ask:${m.id}`,
      kind: 'ask' as const,
      label: m.body.split('\n')[0] ?? '',
    })),
    ...inbox
      .filter((i) => !i.done && i.linkedTaskId === null)
      .map((i) => ({
        key: `note:${i.id}`,
        kind: 'note' as const,
        label: i.createdByRunId === null ? i.text : `${i.text} (agent)`,
      })),
  ];
}
