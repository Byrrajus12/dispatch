import { Activity, type ReactNode } from 'react';

import type { MainView } from '../../lib/twoViews';
import { ErrorBoundary } from './ErrorBoundary';
import { TwoViewTopBar, type TwoViewTopBarProps } from './TwoViewTopBar';

export interface TwoViewShellProps {
  topBar: TwoViewTopBarProps;
  view: MainView;
  /** A resolution, sign-in or get-started screen; it replaces both views. */
  gate: ReactNode | null;
  /** An app-wide notice strip under the top bar (setup problems). */
  banner?: ReactNode;
  overseer: ReactNode;
  tasks: ReactNode;
  /** A drawer over either view; it never changes the view underneath. */
  peek: ReactNode;
  /** The first-task guide card, floating over either view; hidden while a gate is up. */
  guide?: ReactNode;
}

/** Two views: the top bar, then Overseer and Tasks both mounted so each keeps its place. */
export function TwoViewShell({
  topBar,
  view,
  gate,
  banner,
  overseer,
  tasks,
  peek,
  guide,
}: TwoViewShellProps) {
  return (
    <div
      data-testid="two-views-shell"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <TwoViewTopBar {...topBar} />
      {banner}
      <main className="bg-background border-border-panel shadow-panel rounded-popover relative mx-2 mb-2 min-h-0 flex-1 overflow-hidden border-[0.5px]">
        <ErrorBoundary label="this view">
          {gate ?? (
            <>
              <Activity mode={view === 'overseer' ? 'visible' : 'hidden'}>
                {overseer}
              </Activity>
              <Activity mode={view === 'tasks' ? 'visible' : 'hidden'}>
                {tasks}
              </Activity>
              {peek}
              {guide !== undefined && guide !== null && (
                <div
                  data-testid="first-task-guide-slot"
                  className="absolute right-3 bottom-16 z-30"
                >
                  {guide}
                </div>
              )}
            </>
          )}
        </ErrorBoundary>
      </main>
    </div>
  );
}
