import type { ApiClient, RunMeta } from '@dispatch/client';

import { useRunDiff } from '../data';
import { color } from '../theme';
import { List } from './List';
import { runTone } from './Overseer';

// The run's patch, line by line, coloured like `git diff`.
function Diff({
  client,
  port,
  run,
}: {
  client: ApiClient;
  port: number;
  run: RunMeta;
}) {
  const diff = useRunDiff(client, port, run.id);
  if (diff.isError)
    return (
      <text
        fg={color.bad}
      >{`Could not load the diff: ${diff.error instanceof Error ? diff.error.message : 'unknown error'}`}</text>
    );
  if (diff.data === undefined) return <text fg={color.dim}>loading diff…</text>;
  if (diff.data.patch.trim() === '')
    return <text fg={color.dim}>This run changed nothing.</text>;
  return (
    <scrollbox flexGrow={1}>
      {diff.data.patch.split('\n').map((line, i) => (
        <text
          key={i}
          fg={
            line.startsWith('+')
              ? color.ok
              : line.startsWith('-')
                ? color.bad
                : line.startsWith('@@') || line.startsWith('diff ')
                  ? color.accent
                  : color.text
          }
        >
          {line === '' ? ' ' : line}
        </text>
      ))}
    </scrollbox>
  );
}

/** Live and recent runs on the left; the selected run, or its diff (d), on the right. */
export function RunsView({
  client,
  port,
  runs,
  cursor,
  diff,
}: {
  client: ApiClient;
  port: number;
  runs: RunMeta[];
  cursor: number;
  diff: boolean;
}) {
  const selected = runs[cursor];
  return (
    <box flexDirection="row" flexGrow={1}>
      <List
        title="Runs"
        rows={runs.map((r) => ({
          key: r.id,
          label: `${r.id}  ${r.taskTitle}`,
          tone: runTone(r.state),
        }))}
        cursor={cursor}
        focused
        empty="no runs yet"
        width="45%"
      />
      <box
        border
        title={diff ? ' diff ' : ' run '}
        borderColor={color.dim}
        flexDirection="column"
        flexGrow={1}
        paddingLeft={1}
        paddingRight={1}
      >
        {selected === undefined ? (
          <text fg={color.dim}>No run selected.</text>
        ) : diff ? (
          <Diff client={client} port={port} run={selected} />
        ) : (
          <box flexDirection="column">
            <text
              fg={color.text}
            >{`${selected.id}  ${selected.taskTitle}`}</text>
            <text fg={runTone(selected.state)}>{selected.state}</text>
            <text
              fg={color.dim}
            >{`task ${selected.taskId} · updated ${selected.updatedAt}`}</text>
            {selected.error !== undefined && (
              <text fg={color.bad}>{selected.error}</text>
            )}
            <text fg={color.dim}>d to see what it changed</text>
          </box>
        )}
      </box>
    </box>
  );
}
