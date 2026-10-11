import type { SetupStatus } from '@dispatch-foo/core/browser';
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { DetailsDisclosure } from './DetailsDisclosure';
import { Spinner } from '@/ui/spinner';

const ICONS: Record<SetupStatus | 'waiting', ReactNode> = {
  ok: (
    <CircleCheck className="size-4 text-(--state-ready-fg)" aria-label="Done" />
  ),
  unknown: (
    <CircleHelp
      className="text-text-secondary size-4"
      aria-label="Couldn't check"
    />
  ),
  'needs-action': (
    <CircleAlert
      className="size-4 text-(--state-waiting-fg)"
      aria-label="Needs you"
    />
  ),
  missing: (
    <CircleAlert
      className="size-4 text-(--state-waiting-fg)"
      aria-label="Needs you"
    />
  ),
  waiting: (
    <CircleDashed className="text-text-tertiary size-4" aria-label="Not yet" />
  ),
};

interface SetupStepRowProps {
  status: SetupStatus | 'waiting' | 'checking';
  title: string;
  message: string;
  /** Primary fix button(s), shown on the right. */
  action?: ReactNode;
  detail?: string;
  /** Extra controls under the message (identity form, provider list). */
  children?: ReactNode;
}

/** One numbered line of the setup checklist. */
export function SetupStepRow({
  status,
  title,
  message,
  action,
  detail,
  children,
}: SetupStepRowProps) {
  return (
    <section
      className="border-border flex flex-col gap-2 border-b py-4 last:border-b-0"
      aria-label={title}
    >
      <div className="flex items-start gap-3">
        <div className="pt-0.5">
          {status === 'checking' ? (
            <Spinner className="size-4" />
          ) : (
            ICONS[status]
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-sm font-medium">{title}</h2>
          <p className="text-text-secondary text-sm">{message}</p>
        </div>
        {action !== undefined && (
          <div className="flex shrink-0 gap-2">{action}</div>
        )}
      </div>
      {(children !== undefined || detail !== undefined) && (
        <div className="flex flex-col gap-2 pl-7">
          {children}
          {detail !== undefined && <DetailsDisclosure text={detail} />}
        </div>
      )}
    </section>
  );
}
