import type { InboxItem } from '@dispatch/client';
import { useState } from 'react';

import { Pill } from '@/ui/ai/pill';
import { Button } from '@/ui/button';
import { SectionLabel } from '@/ui/chrome';

export interface CapturedNotesProps {
  /** Open captures, already filtered and sorted by `openCaptures`. */
  items: readonly InboxItem[];
  /** The raw handlers: a rejection is shown on the row, so nothing swallows it first. */
  onMakeTask: (ids: string[]) => Promise<unknown>;
  onDismiss: (ids: string[]) => Promise<void>;
}

/** Quick captures and agents' `dispatch_note`s, waiting in Coming in until made a task or dismissed. */
export function CapturedNotes({
  items,
  onMakeTask,
  onDismiss,
}: CapturedNotesProps) {
  if (items.length === 0) return null;
  return (
    <section
      aria-label="Noted"
      data-testid="captured-notes"
      className="flex flex-col gap-1.5"
    >
      <h2 className="contents">
        <SectionLabel>Noted</SectionLabel>
      </h2>
      {items.map((item) => (
        <CapturedNote
          key={item.id}
          item={item}
          onMakeTask={onMakeTask}
          onDismiss={onDismiss}
        />
      ))}
    </section>
  );
}

// One capture with its two actions; a failed action leaves its reason on the row.
function CapturedNote({
  item,
  onMakeTask,
  onDismiss,
}: {
  item: InboxItem;
  onMakeTask: CapturedNotesProps['onMakeTask'];
  onDismiss: CapturedNotesProps['onDismiss'];
}) {
  const [error, setError] = useState<string | null>(null);
  const run = (action: (ids: string[]) => Promise<unknown>) => {
    setError(null);
    action([item.id]).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'That did not go through');
    });
  };
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm">{item.text}</span>
        {item.createdByRunId !== null && <Pill>agent</Pill>}
        <Button variant="ghost" size="xs" onClick={() => run(onMakeTask)}>
          Make task
        </Button>
        <Button variant="ghost" size="xs" onClick={() => run(onDismiss)}>
          Dismiss
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      )}
    </div>
  );
}
