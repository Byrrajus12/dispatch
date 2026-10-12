import type { ApiClient, RunMeta } from '@dispatch/client';

import { useRunDiff } from '../data';
import { safeText } from '../safe';
import { color } from '../theme';
import { List } from './List';
import { runTone } from './Overseer';
import { Patch } from './Patch';

// The run's patch, once loaded.
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
  if (diff.isError) {
    return (
      <text fg={color.bad}>
        {`Could not load the diff: ${diff.error instanceof Error ? diff.error.message : 'unknown error'}`}
      </text>
    );
  }
  if (diff.data === undefined) return <text fg={color.dim}>loading diff…</text>;
  if (diff.data.patch.trim() === '')
    return <text fg={color.dim}>This run changed nothing.</text>;
  return <Patch patch={diff.data.patch} />;
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
            <text fg={color.text}>
              {safeText(`${selected.id}  ${selected.taskTitle}`)}
            </text>
            <text fg={runTone(selected.state)}>{selected.state}</text>
            <text
              fg={color.dim}
            >{`task ${selected.taskId} · updated ${selected.updatedAt}`}</text>
            {selected.error !== undefined && (
              <text fg={color.bad}>{safeText(selected.error)}</text>
            )}
            <text fg={color.dim}>d to see what it changed</text>
          </box>
        )}
      </box>
    </box>
  );
}
