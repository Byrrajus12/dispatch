import type { TaskDoc } from '@dispatch-foo/core/browser';

import { color } from '../theme';
import { List } from './List';

/** Every task on the left; the selected one's spec on the right. */
export function TasksView({
  tasks,
  cursor,
}: {
  tasks: TaskDoc[];
  cursor: number;
}) {
  const selected = tasks[cursor];
  return (
    <box flexDirection="row" flexGrow={1}>
      <List
        title="Tasks"
        rows={tasks.map((t) => ({
          key: t.meta.id,
          label: `${t.meta.status.padEnd(8).slice(0, 8)} ${t.meta.title}`,
        }))}
        cursor={cursor}
        focused
        empty="no tasks yet"
        width="45%"
      />
      <box
        border
        title=" task "
        borderColor={color.dim}
        flexDirection="column"
        flexGrow={1}
        paddingLeft={1}
        paddingRight={1}
      >
        {selected === undefined ? (
          <text fg={color.dim}>Pick a task with j / k.</text>
        ) : (
          <scrollbox flexGrow={1}>
            <text
              fg={color.text}
            >{`${selected.meta.id}  ${selected.meta.title}`}</text>
            <text
              fg={color.dim}
            >{`${selected.meta.status} · ${selected.meta.priority}`}</text>
            <text fg={color.text}>
              {selected.body.trim() === ''
                ? '(no description)'
                : selected.body.trim()}
            </text>
          </scrollbox>
        )}
      </box>
    </box>
  );
}
