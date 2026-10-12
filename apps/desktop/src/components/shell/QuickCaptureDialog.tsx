import { Inbox } from 'lucide-react';
import { useRef, useState } from 'react';

import {
  BRAIN_DUMP_DRAFT_KEY,
  usePersistedDraft,
} from '../../hooks/usePersistedDraft';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogBody,
  DialogChrome,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/ui/dialog';
import { Textarea } from '@/ui/textarea';

interface QuickCaptureDialogProps {
  /** Owned by App so the ⌘D global shortcut and the rail's "Drop a thought" row open the
   * same dialog. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The RAW capture handler (`rawData.handleCaptureInbox`), not the `withActionFeedback`
   * wrapper: the wrapper swallows rejections, and this modal must keep the draft and show
   * the error inline when a capture fails rather than clearing it as if it landed. */
  onCapture: (text: string) => Promise<void>;
}

/**
 * The one-shot capture dialog (⌘D, or the rail's "Drop a thought"): a passing thought is
 * dropped into the inbox from any screen without leaving it, and shows in the Overseer's
 * Coming in. One item per line, ⌘⏎ commits, and a successful capture closes the dialog.
 */
export function QuickCaptureDialog({
  open,
  onOpenChange,
  onCapture,
}: QuickCaptureDialogProps) {
  // A persisted draft: closing the dialog, navigating or relaunching never costs a
  // half-typed thought.
  const [draft, setDraft] = usePersistedDraft(BRAIN_DUMP_DRAFT_KEY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function capture(): void {
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await onCapture(draft);
        // The draft is only dropped once it has landed; on failure it stays put above the
        // error so nothing typed is ever lost.
        setDraft('');
        onOpenChange(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[30%] w-[32rem] max-w-[calc(100vw-2rem)]"
        showCloseButton={false}
        // The dialog opens straight into the box — the whole point is typing immediately.
        initialFocus={textareaRef}
      >
        <DialogChrome>
          <span>Notes</span>
          <span aria-hidden>›</span>
          <span className="text-(--text-secondary)">Quick capture</span>
        </DialogChrome>
        <DialogTitle className="sr-only">Quick capture</DialogTitle>
        <DialogDescription className="sr-only">
          Capture quick thoughts, one per line, into the Notes inbox.
        </DialogDescription>
        <DialogBody className="gap-2 pt-0">
          <Textarea
            ref={textareaRef}
            variant="borderless"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // ⌘⏎ commits, same as the full Brain dump composer; plain Enter stays a
              // newline so several thoughts can go down in one dump.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                // `!busy` mirrors the button's own disabled state — without it a rapid
                // double ⌘⏎ would capture the same draft twice.
                if (draft.trim() !== '' && !busy) capture();
              }
            }}
            placeholder="Dump it here…"
            className="field-sizing-fixed min-h-[96px] resize-none text-[15px] leading-6"
          />
          {error !== null && (
            <p className="text-state-failed text-[12px]">{error}</p>
          )}
        </DialogBody>
        <DialogFooter
          className="pt-0"
          leading={
            <span className="text-muted-foreground text-[11px]">
              ⌘⏎ to drop it
            </span>
          }
        >
          <Button
            size="sm"
            disabled={draft.trim() === '' || busy}
            onClick={capture}
          >
            <Inbox />
            Drop it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
