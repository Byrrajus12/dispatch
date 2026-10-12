import type { ReactNode } from 'react';

import { GLOSSARY, type GlossaryKey } from '../../lib/glossary';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

/** A first-screen word with a dotted underline; hovering or focusing it shows its definition. */
export function GlossaryTerm({
  term,
  children,
  defaultOpen,
}: {
  term: GlossaryKey;
  children: ReactNode;
  /** Opens the hint on mount; tests use it, since hover timing is not reliable in happy-dom. */
  defaultOpen?: boolean;
}) {
  return (
    <Tooltip defaultOpen={defaultOpen}>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            data-glossary={term}
            className="focus-visible:ring-ring cursor-help underline decoration-dotted underline-offset-[3px] outline-none focus-visible:rounded-[2px] focus-visible:ring-2"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{GLOSSARY[term]}</TooltipContent>
    </Tooltip>
  );
}
