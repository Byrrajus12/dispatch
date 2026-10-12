import { type NavState, READ_ONLY } from '../nav';
import { color } from '../theme';

// What the keys do right now, so the bottom line doubles as the help a newcomer needs.
function hints(nav: NavState): string {
  if (nav.composing) return 'enter send · esc stop typing';
  if (nav.view === 'overseer') {
    return nav.card !== null
      ? 'y approve · n reject · j/k cards · i type · ? help · q quit'
      : 'i type · j cards · tab columns · 2 tasks · 3 runs · ? help · q quit';
  }
  if (nav.view === 'runs')
    return 'j/k move · d diff · 1 overseer · ? help · q quit';
  return 'j/k move · 1 overseer · 3 runs · ? help · q quit';
}

/** The bottom line: a problem first, then a notice, then read-only, then the key hints. */
export function StatusLine({
  nav,
  error,
  readOnly,
}: {
  nav: NavState;
  error: string | null;
  readOnly: boolean;
}) {
  if (error !== null) {
    return <text fg={color.bad}>{` dispatchd: ${error} · retrying`}</text>;
  }
  if (nav.notice !== null) {
    return <text fg={color.warn}>{` ${nav.notice}`}</text>;
  }
  if (readOnly) return <text fg={color.warn}>{` ${READ_ONLY}`}</text>;
  return <text fg={color.dim}>{` ${hints(nav)}`}</text>;
}
