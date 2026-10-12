import type { View } from '../nav';
import { color } from '../theme';

const TABS: { view: View; key: string; label: string }[] = [
  { view: 'overseer', key: '1', label: 'overseer' },
  { view: 'tasks', key: '2', label: 'tasks' },
  { view: 'runs', key: '3', label: 'runs' },
  { view: 'docs', key: '4', label: 'docs' },
  { view: 'threads', key: '5', label: 'threads' },
  { view: 'prs', key: '6', label: 'prs' },
];

/** The project, the views with their keys, and, when the side columns are hidden, their counts. */
export function Header({
  project,
  view,
  counts,
  wide,
}: {
  project: string;
  view: View;
  counts: { in: number; out: number } | null;
  /** Narrow terminals name only the current view; the rest are their keys. */
  wide: boolean;
}) {
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={color.accent}>{`dispatch · ${project}`}</text>
      <box flexDirection="row" gap={wide ? 2 : 1}>
        {counts !== null && (
          <text fg={color.dim}>{`in ${counts.in} · out ${counts.out}`}</text>
        )}
        {TABS.map((t) => (
          <text key={t.view} fg={t.view === view ? color.text : color.dim}>
            {t.view === view
              ? `[${t.key} ${t.label}]`
              : wide
                ? `${t.key} ${t.label}`
                : t.key}
          </text>
        ))}
      </box>
    </box>
  );
}
