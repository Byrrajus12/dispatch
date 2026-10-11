import { OctagonAlert } from 'lucide-react';

import { DetailsDisclosure } from '../setup/DetailsDisclosure';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
import { Spinner } from '@/ui/spinner';

interface DaemonUnavailableProps {
  /** The daemon is still starting — a lighter, non-error status line, no Retry button (there
   * is nothing to retry yet). */
  starting: boolean;
  errorDetail: unknown;
  onRetry: () => void;
}

/**
 * The background-service-unreachable empty state, extracted from the original `BoardView` (I4 in the
 * phase-8 fix report) so every primary dispatch view shows the *same* starting/error/retry
 * treatment instead of each one growing its own copy (or, worse, silently showing an
 * unrelated "Loading…" state forever when the daemon never came up at all — the bug this was
 * extracted to fix in `TasksListView`/`PlansView`).
 */
export function DaemonUnavailable({
  starting,
  errorDetail,
  onRetry,
}: DaemonUnavailableProps) {
  if (starting) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <Spinner className="text-muted-foreground size-5" />
        <EmptyState
          message="Starting Dispatch’s background service…"
          className="p-0"
        />
      </div>
    );
  }

  const detail = describeDaemonError(errorDetail);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <OctagonAlert className="text-destructive size-5" />
      <EmptyState
        message="Dispatch couldn’t start for this project"
        className="p-0"
        action={
          <>
            {detail !== null && <DetailsDisclosure text={detail} />}
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </>
        }
      />
    </div>
  );
}

// Tauri `invoke` rejections arrive as plain strings (the Rust command's
// Err(String)), not Error instances — an `instanceof Error` check alone
// silently swallows exactly the diagnostic detail (daemon output tail, log
// path) the sidecar now works to provide. Accept both shapes.
export function describeDaemonError(errorDetail: unknown): string | null {
  if (errorDetail instanceof Error) return errorDetail.message;
  if (typeof errorDetail === 'string' && errorDetail.length > 0) {
    return errorDetail;
  }
  return null;
}
