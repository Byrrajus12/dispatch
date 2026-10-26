import { X } from 'lucide-react';
import { Fragment } from 'react';

import {
  clauseParts,
  type FilterClause,
  type FilterContext,
  removeFilterClause,
  setFilterJoin,
  type TaskFilterSet,
  toggleClauseNegation,
} from '../../lib/taskFilters';
import { cn } from '@/lib/utils';
import { Pill, PillButton, SelectPill } from '@/ui/ai/pill';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

export interface AppliedFiltersProps {
  filters: TaskFilterSet;
  onChange: (filters: TaskFilterSet) => void;
  /** Milestone titles for the chip labels. */
  context?: FilterContext;
  className?: string;
}

// The operator half of a chip: a text button for `is`/`is not` (click flips it), plain
// text for the operators with nothing to flip to.
function OpControl({
  clause,
  onToggle,
}: {
  clause: FilterClause;
  onToggle: () => void;
}) {
  if (clause.op !== 'is' && clause.op !== 'is not') {
    return <span className="text-muted-foreground">{clause.op}</span>;
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`Change operator, currently ${clause.op}`}
      className="text-muted-foreground focus-visible:ring-ring rounded-[4px] outline-none hover:text-(--text-secondary) focus-visible:ring-2"
    >
      {clause.op}
    </button>
  );
}

/**
 * The applied-filter strip under the Tasks header (§7): one `Pill` per clause —
 * `Status is In progress ×` — with a single `and`/`or` select between them (the set has
 * one join, so every connector reads and edits the same value). Renders nothing when no
 * filter is applied.
 */
export function AppliedFilters({
  filters,
  onChange,
  context = {},
  className,
}: AppliedFiltersProps) {
  if (filters.clauses.length === 0) return null;
  return (
    <div
      data-slot="applied-filters"
      className={cn('flex flex-wrap items-center gap-1.5', className)}
    >
      {filters.clauses.map((clause, index) => {
        const parts = clauseParts(clause, context);
        return (
          <Fragment key={`${clause.facet}:${index}`}>
            {index > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<SelectPill aria-label="Filter join" />}
                  className="h-6 px-2"
                >
                  {filters.join}
                </DropdownMenuTrigger>
                <DropdownMenuContent className="min-w-[96px]">
                  <DropdownMenuRadioGroup
                    value={filters.join}
                    onValueChange={(join) =>
                      onChange(
                        setFilterJoin(filters, join === 'or' ? 'or' : 'and')
                      )
                    }
                  >
                    <DropdownMenuRadioItem value="and">
                      and
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="or">or</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Pill
              data-slot="filter-chip"
              data-facet={clause.facet}
              className="gap-1"
            >
              <span className="text-muted-foreground">{parts.facet}</span>
              <OpControl
                clause={clause}
                onToggle={() => onChange(toggleClauseNegation(filters, index))}
              />
              <span className="min-w-0 truncate">{parts.values}</span>
              <button
                type="button"
                aria-label={`Remove ${parts.facet} filter`}
                onClick={() => onChange(removeFilterClause(filters, index))}
                className="text-muted-foreground focus-visible:ring-ring -mr-1 flex size-4 items-center justify-center rounded-[4px] outline-none hover:text-(--text-secondary) focus-visible:ring-2"
              >
                <X className="size-3" aria-hidden />
              </button>
            </Pill>
          </Fragment>
        );
      })}
      {filters.clauses.length > 1 && (
        <PillButton
          onClick={() => onChange({ ...filters, clauses: [] })}
          className="text-muted-foreground h-6 border-transparent bg-transparent px-2"
        >
          Clear
        </PillButton>
      )}
    </div>
  );
}
