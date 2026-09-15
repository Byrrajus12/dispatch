import { Check, ChevronDown } from 'lucide-react';

import { modelLabel, MODELS } from '../../lib/models';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

interface ModelPickerProps {
  /** The selected model id — the label the trigger shows. */
  value: string;
  onChange: (id: string) => void;
  /** Accessible name for the trigger, e.g. "Planning model". */
  label: string;
  disabled?: boolean;
}

/**
 * The composer's model pick — the same quiet label-and-chevron dropdown the
 * task panel uses beside Dispatch, shared by the Plans composer and the
 * overseer composer so "which model does this open on" reads the same in
 * both. Lists `MODELS` with a check on the current choice.
 */
export function ModelPicker({
  value,
  onChange,
  label,
  disabled = false,
}: ModelPickerProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          aria-label={label}
          className="text-muted-foreground hover:bg-muted/60 hover:text-foreground h-auto gap-1 rounded-md border border-transparent px-2 py-1 text-[12px] has-[>svg]:px-2"
        >
          {modelLabel(value)}
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {MODELS.map((m) => (
          <DropdownMenuItem
            key={m.id}
            onSelect={() => onChange(m.id)}
            className="gap-2 pr-8 text-[13px]"
          >
            <span className="flex flex-1 flex-col">
              <span>{m.label}</span>
              <span className="text-muted-foreground text-[11px]">
                {m.hint}
              </span>
            </span>
            {m.id === value && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
