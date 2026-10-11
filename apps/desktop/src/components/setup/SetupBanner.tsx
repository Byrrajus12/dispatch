import type { SetupReport } from '@dispatch-foo/core/browser';
import { CircleAlert } from 'lucide-react';

import { Button } from '@/ui/button';

/** A slim app-wide strip when a setup check fails after first launch (e.g. signed out). */
export function SetupBanner({
  report,
  onOpen,
}: {
  report: SetupReport | undefined;
  onOpen: () => void;
}) {
  const problem = report?.steps.find(
    (s) => s.status === 'missing' || s.status === 'needs-action'
  );
  if (problem === undefined) return null;
  return (
    <div
      className="border-border bg-muted flex items-center gap-2 border-b px-3 py-1.5 text-sm"
      role="status"
    >
      <CircleAlert className="size-4 text-(--state-waiting-fg)" />
      <span className="flex-1">{problem.message}</span>
      <Button size="sm" variant="outline" onClick={onOpen}>
        Fix it
      </Button>
    </div>
  );
}
