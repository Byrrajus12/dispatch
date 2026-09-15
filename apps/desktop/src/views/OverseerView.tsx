import { Plus } from 'lucide-react';

import { OverseerChat } from '../components/chat/OverseerChat';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { OverseerSession } from '../hooks/useOverseerSession';
import { Button } from '@/ui/button';

interface OverseerViewProps {
  data: DispatchProjectData;
  overseer: OverseerSession;
}

/**
 * The Overseer page — a chat with the project assistant. The conversation itself
 * (transcript, composer, confirm cards) is OverseerChat, shared with the
 * LiveRail's Overseer tab; this page adds only the daemon gate and the
 * new-conversation action. The session lives in `useOverseerSession` (mounted by
 * App), so switching views and coming back lands on the same transcript.
 */
export function OverseerView({ data, overseer }: OverseerViewProps) {
  // Same gate as OverseerChat's compact reset: a queued mutation must stay
  // decidable, and a parked built-in call would block its session for good.
  // `record` is already vetoed by useOverseerSession when the daemon says the
  // conversation is gone, so this cannot lock on a ghost.
  const hasPendingAction =
    (overseer.record?.pendingActions.length ?? 0) > 0 ||
    (overseer.record?.pendingApprovals.length ?? 0) > 0;

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[60rem] flex-col gap-4">
      <div className="flex items-center justify-end gap-3">
        {overseer.conversationId !== null && (
          // reset() drops the only UI handle on the conversation, so a queued
          // mutation must be decided before this can discard its confirm card.
          <Button
            variant="outline"
            size="sm"
            disabled={hasPendingAction}
            title={
              hasPendingAction ? 'Decide the pending action first' : undefined
            }
            onClick={() => overseer.reset()}
          >
            <Plus className="size-3.5" /> New conversation
          </Button>
        )}
      </div>

      <OverseerChat overseer={overseer} />
    </div>
  );
}
