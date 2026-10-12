// Where focus is and what a key does there. Pure, so every focus rule is unit-tested
// without a terminal; the App only maps OpenTUI key events in and side effects out.

export type View = 'overseer' | 'tasks' | 'runs';
export type Pane = 'in' | 'conversation' | 'out' | 'list';
type ListName = 'in' | 'out' | 'list';

export interface NavState {
  view: View;
  pane: Pane;
  composing: boolean;
  /** The focused proposal card in the conversation, or null when none has focus. */
  card: number | null;
  cursor: Record<ListName, number>;
  overlay: 'in' | 'out' | 'help' | null;
  diff: boolean;
  notice: string | null;
}

export interface Key {
  name: string;
  ctrl: boolean;
  shift: boolean;
}

export interface NavContext {
  /** At least 120 columns: the Overseer's side columns are shown. */
  wide: boolean;
  /** Pending proposal cards in the open conversation. */
  cards: number;
  lengths: Record<ListName, number>;
}

export type NavAction =
  | { type: 'view'; view: View }
  | { type: 'pane'; dir: 1 | -1 }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'compose'; on: boolean }
  | { type: 'decide'; card: number; approve: boolean }
  | { type: 'open' }
  | { type: 'diff'; on: boolean }
  | { type: 'overlay'; which: NavState['overlay'] }
  | { type: 'notice'; text: string }
  | { type: 'quit' };

export const initialNav: NavState = {
  view: 'overseer',
  pane: 'conversation',
  composing: false,
  card: null,
  cursor: { in: 0, out: 0, list: 0 },
  overlay: null,
  diff: false,
  notice: null,
};

const PHASE_3 = 'Docs, threads, PRs and projects arrive in phase 3.';
const OVERSEER_PANES: Pane[] = ['in', 'conversation', 'out'];

/** Maps one key to an action, or null when the key belongs to someone else (the composer). */
export function resolveKey(
  state: NavState,
  key: Key,
  ctx: NavContext
): NavAction | null {
  if (key.ctrl && key.name === 'c') return { type: 'quit' };
  if (state.composing) {
    return key.name === 'escape' ? { type: 'compose', on: false } : null;
  }
  if (key.ctrl && key.name === 'p') return { type: 'notice', text: PHASE_3 };
  if (key.name === 'escape') {
    if (state.overlay !== null) return { type: 'overlay', which: null };
    if (state.diff) return { type: 'diff', on: false };
    return null;
  }
  switch (key.name) {
    case '1':
      return { type: 'view', view: 'overseer' };
    case '2':
      return { type: 'view', view: 'tasks' };
    case '3':
      return { type: 'view', view: 'runs' };
    case '4':
    case '5':
    case '6':
      return { type: 'notice', text: PHASE_3 };
    case 'q':
      return { type: 'quit' };
    case '?':
      return {
        type: 'overlay',
        which: state.overlay === 'help' ? null : 'help',
      };
    case 'i':
    case '/':
      return state.view === 'overseer' ? { type: 'compose', on: true } : null;
    case 'tab':
      return { type: 'pane', dir: key.shift ? -1 : 1 };
    case 'j':
    case 'down':
      return { type: 'move', delta: 1 };
    case 'k':
    case 'up':
      return { type: 'move', delta: -1 };
    case 'return':
      return { type: 'open' };
    case '[':
      return ctx.wide || state.view !== 'overseer'
        ? null
        : { type: 'overlay', which: 'in' };
    case ']':
      return ctx.wide || state.view !== 'overseer'
        ? null
        : { type: 'overlay', which: 'out' };
    case 'd':
      return state.view === 'runs' ? { type: 'diff', on: true } : null;
    case 'y':
    case 'n':
      return state.view === 'overseer' &&
        state.pane === 'conversation' &&
        state.card !== null &&
        state.card < ctx.cards
        ? { type: 'decide', card: state.card, approve: key.name === 'y' }
        : null;
    default:
      return null;
  }
}

const clamp = (n: number, max: number) => Math.max(0, Math.min(n, max));

/** Applies an action; `decide`, `open` and `quit` are side effects the App performs. */
export function navReducer(
  state: NavState,
  action: NavAction,
  ctx: NavContext
): NavState {
  switch (action.type) {
    case 'view':
      return {
        ...initialNav,
        view: action.view,
        pane: action.view === 'overseer' ? 'conversation' : 'list',
        cursor: action.view === state.view ? state.cursor : initialNav.cursor,
      };
    case 'pane': {
      if (state.view !== 'overseer' || !ctx.wide) return state;
      const i = OVERSEER_PANES.indexOf(state.pane);
      const next =
        (i + action.dir + OVERSEER_PANES.length) % OVERSEER_PANES.length;
      return {
        ...state,
        pane: OVERSEER_PANES[next] ?? 'conversation',
        card: null,
      };
    }
    case 'move': {
      if (state.pane === 'conversation') {
        if (ctx.cards === 0) return state;
        const at = state.card ?? -1;
        const next = at + action.delta;
        return { ...state, card: next < 0 ? null : clamp(next, ctx.cards - 1) };
      }
      const list: ListName = state.pane === 'list' ? 'list' : state.pane;
      const max = Math.max(0, ctx.lengths[list] - 1);
      return {
        ...state,
        cursor: {
          ...state.cursor,
          [list]: clamp(state.cursor[list] + action.delta, max),
        },
      };
    }
    case 'compose':
      return { ...state, composing: action.on, card: null, notice: null };
    case 'overlay':
      return { ...state, overlay: action.which };
    case 'diff':
      return { ...state, diff: action.on };
    case 'notice':
      return { ...state, notice: action.text };
    default:
      return state;
  }
}
