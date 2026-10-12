import type {
  OverseerAction,
  OverseerMessage,
  OverseerSession,
  RunMeta,
} from '@dispatch/client';
import { useRef } from 'react';

import type { InflowItem } from '../lists';
import type { NavState } from '../nav';
import { safeText } from '../safe';
import { color } from '../theme';
import { List } from './List';

const SPEAKER: Partial<Record<OverseerMessage['role'], string>> = {
  user: 'you',
  assistant: 'overseer',
  notice: 'note',
};

// One character per run state, so a narrow column still says what each run is doing.
const runGlyph = (state: RunMeta['state']): string =>
  state === 'finished'
    ? '✓'
    : state === 'failed' || state === 'interrupted-dirty'
      ? '✕'
      : state === 'cancelled'
        ? '–'
        : state === 'awaiting-approval'
          ? '!'
          : '●';

export const runTone = (state: RunMeta['state']): string =>
  state === 'failed' || state === 'interrupted-dirty'
    ? color.bad
    : state === 'finished'
      ? color.ok
      : state === 'awaiting-approval'
        ? color.warn
        : color.text;

// One proposal the Overseer queued: nothing happens until the human decides it here.
function Card({
  action,
  focused,
  deciding,
}: {
  action: OverseerAction;
  focused: boolean;
  deciding: boolean;
}) {
  return (
    <box
      border
      title=" proposal "
      borderColor={focused ? color.accent : color.dim}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={color.text}>{safeText(action.summary)}</text>
      <text fg={focused ? color.accent : color.dim}>
        {deciding
          ? 'deciding…'
          : focused
            ? '[y] approve   [n] reject'
            : 'j to focus'}
      </text>
    </box>
  );
}

/** Coming in | the conversation with its cards and composer | Going out; side columns only when wide. */
export function OverseerView({
  session,
  nav,
  inflow,
  outflow,
  wide,
  composerKey,
  onSubmit,
}: {
  session: OverseerSession;
  nav: NavState;
  inflow: InflowItem[];
  outflow: RunMeta[];
  wide: boolean;
  composerKey: number;
  onSubmit: (text: string) => void;
}) {
  const draft = useRef('');
  const messages = (session.record?.messages ?? []).filter(
    (m) => SPEAKER[m.role] !== undefined
  );
  const cards = (session.record?.pendingActions ?? []).filter(
    (a) => a.status === 'pending'
  );
  const inRows = inflow.map((i) => ({
    key: i.key,
    label: `${i.kind === 'ask' ? '?' : '·'} ${i.label}`,
    tone: i.kind === 'ask' ? color.warn : color.text,
  }));
  const outRows = outflow.map((r) => ({
    key: r.id,
    label: `${runGlyph(r.state)} ${r.taskTitle}`,
    tone: runTone(r.state),
  }));
  const showIn = wide || nav.overlay === 'in';
  const showOut = wide || nav.overlay === 'out';
  return (
    <box flexDirection="row" flexGrow={1}>
      {showIn && (
        <List
          title="Coming in"
          rows={inRows}
          cursor={nav.cursor.in}
          focused={nav.pane === 'in' || nav.overlay === 'in'}
          empty="nothing waiting on you"
          width={wide ? '30%' : undefined}
        />
      )}
      {(wide || nav.overlay === null || nav.overlay === 'help') && (
        <box
          border
          title=" overseer "
          borderColor={nav.pane === 'conversation' ? color.accent : color.dim}
          flexDirection="column"
          flexGrow={1}
          paddingLeft={1}
          paddingRight={1}
        >
          <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
            {messages.length === 0 ? (
              <text fg={color.dim}>
                What should we work on? Press i to type.
              </text>
            ) : (
              messages.map((m, i) => (
                <text
                  key={`${m.at}-${i}`}
                  fg={m.role === 'user' ? color.accent : color.text}
                >
                  {`${SPEAKER[m.role] ?? m.role}: ${safeText(m.text)}`}
                </text>
              ))
            )}
            {cards.map((a, i) => (
              <Card
                key={a.id}
                action={a}
                focused={nav.card === i}
                deciding={session.decidingActionId === a.id}
              />
            ))}
          </scrollbox>
          {session.decideError !== null && (
            <text fg={color.bad}>{safeText(session.decideError)}</text>
          )}
          {session.sendError !== null && (
            <text fg={color.bad}>{safeText(session.sendError)}</text>
          )}
          <box
            border
            borderColor={nav.composing ? color.accent : color.dim}
            height={3}
          >
            <input
              key={composerKey}
              focused={nav.composing}
              placeholder={
                nav.composing ? 'type, enter to send' : 'press i to type'
              }
              onInput={(value: string) => {
                draft.current = value;
              }}
              // No argument: the input's prop type also carries a textarea's event-style handler.
              onSubmit={() => {
                const text = draft.current;
                // The input remounts empty, and onInput only fires on change.
                draft.current = '';
                onSubmit(text);
              }}
            />
          </box>
        </box>
      )}
      {showOut && (
        <List
          title="Going out"
          rows={outRows}
          cursor={nav.cursor.out}
          focused={nav.pane === 'out' || nav.overlay === 'out'}
          empty="no runs yet"
          width={wide ? '30%' : undefined}
        />
      )}
    </box>
  );
}
