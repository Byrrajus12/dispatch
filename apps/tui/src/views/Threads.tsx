import type { ApiClient } from '@dispatch/client';

import { useThreads } from '../data';
import { safeText } from '../safe';
import { color } from '../theme';
import { List } from './List';

const firstLine = (body: string) => body.split('\n')[0] ?? '';

/** Recent conversations on the message bus; the selected one's messages on the right. */
export function ThreadsView({
  client,
  port,
  cursor,
  canDecide,
}: {
  client: ApiClient;
  port: number;
  cursor: number;
  canDecide: boolean;
}) {
  const list = useThreads(client, port, canDecide, null);
  const selected = list.threads[cursor];
  const { messages } = useThreads(
    client,
    port,
    canDecide,
    selected?.thread ?? null
  );
  if (!canDecide) {
    return (
      <text fg={color.warn}>
        {' '}
        Threads need the app token; see the status line.
      </text>
    );
  }
  return (
    <box flexDirection="row" flexGrow={1}>
      <List
        title="Threads"
        rows={list.threads.map((t) => ({
          key: t.thread,
          label: `${t.count}  ${firstLine(t.root.body)}`,
        }))}
        cursor={cursor}
        focused
        empty="no conversations yet"
        width="40%"
      />
      <box
        border
        title=" thread "
        borderColor={color.dim}
        flexDirection="column"
        flexGrow={1}
        paddingLeft={1}
        paddingRight={1}
      >
        {selected === undefined ? (
          <text fg={color.dim}>Pick a thread with j / k.</text>
        ) : (
          <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
            {messages.map((m) => (
              <text
                key={m.id}
                fg={m.from.startsWith('human:') ? color.accent : color.text}
              >
                {safeText(`${m.from}: ${m.body}`)}
              </text>
            ))}
          </scrollbox>
        )}
      </box>
    </box>
  );
}
