import type { CodeViewHandle } from '@pierre/diffs/react';
import { useEffect, useRef } from 'react';

import { DiffSurface } from '../code/DiffSurface';

interface GitDiffPaneProps {
  patch: string | undefined;
  loading: boolean;
  /**
   * The file to scroll into view. The whole patch stays rendered either way, so the reviewer
   * can keep scrolling past the file they picked instead of coming back for the next one;
   * picking a file only moves the scroller to it.
   */
  focus?: string;
  emptyLabel?: string;
}

/** The Git page's diff renderer: the shared `DiffSurface` with no review state layered on —
 * no file tree, no comment threads, no findings. */
export function GitDiffPane({
  patch,
  loading,
  focus,
  emptyLabel = 'No changes to show.',
}: GitDiffPaneProps) {
  const viewRef = useRef<CodeViewHandle<undefined> | null>(null);
  // Re-run on `patch` too: a refetched patch rebuilds the rows underneath, and the file the
  // reviewer picked should still be the one on screen afterwards. Deferred a frame so the
  // rows exist to scroll to.
  useEffect(() => {
    if (focus === undefined) return undefined;
    const frame = requestAnimationFrame(() => {
      viewRef.current?.scrollTo({ type: 'item', id: focus, align: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus, patch]);
  return (
    <DiffSurface
      patch={patch}
      loading={loading}
      emptyLabel={emptyLabel}
      viewRef={viewRef}
    />
  );
}
