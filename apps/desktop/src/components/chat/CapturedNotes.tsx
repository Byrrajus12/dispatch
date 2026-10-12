import type { InboxItem } from '@dispatch/client';

import { Pill } from '@/ui/ai/pill';
import { Button } from '@/ui/button';
import { SectionLabel } from '@/ui/chrome';

export interface CapturedNotesProps {
  /** Open captures, already filtered and sorted by `openCaptures`. */
  items: readonly InboxItem[];
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
        <div key={item.id} className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm">{item.text}</span>
          {item.createdByRunId !== null && <Pill>agent</Pill>}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void onMakeTask([item.id])}
          >
            Make task
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void onDismiss([item.id])}
          >
            Dismiss
          </Button>
        </div>
      ))}
    </section>
  );
}
