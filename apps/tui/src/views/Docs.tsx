import type { ApiClient } from '@dispatch/client';

import { useDocs } from '../data';
import { safeText } from '../safe';
import { color } from '../theme';
import { List } from './List';

/** Team docs on the left; the selected doc's text on the right. */
export function DocsView({
  client,
  port,
  cursor,
}: {
  client: ApiClient;
  port: number;
  cursor: number;
}) {
  const first = useDocs(client, port, null);
  const selected = first.docs[cursor];
  const { text } = useDocs(client, port, selected?.id ?? null);
  return (
    <box flexDirection="row" flexGrow={1}>
      <List
        title="Docs"
        rows={first.docs.map((d) => ({
          key: d.id,
          label: `${d.status.padEnd(8).slice(0, 8)} ${d.title}`,
        }))}
        cursor={cursor}
        focused
        empty="no docs yet"
        width="40%"
      />
      <box
        border
        title=" doc "
        borderColor={color.dim}
        flexDirection="column"
        flexGrow={1}
        paddingLeft={1}
        paddingRight={1}
      >
        {selected === undefined ? (
          <text fg={color.dim}>Pick a doc with j / k.</text>
        ) : text === null ? (
          <text fg={color.dim}>loading…</text>
        ) : (
          <scrollbox flexGrow={1}>
            <text fg={color.text}>{safeText(text)}</text>
          </scrollbox>
        )}
      </box>
    </box>
  );
}
