import { ChevronRight } from 'lucide-react';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/collapsible';

/** Raw output, hidden until asked for — setup errors lead with a sentence, not a log. */
export function DetailsDisclosure({ text }: { text: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="text-text-secondary flex items-center gap-1 text-xs">
        <ChevronRight className="size-3" />
        Details
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="bg-surface-quaternary mt-1 max-h-40 overflow-auto rounded p-2 font-mono text-[11px] whitespace-pre-wrap">
          {text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
