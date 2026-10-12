import type { Project } from '../projects';
import { List } from './List';

/** The project picker: every project with a running dispatchd, the current one marked. */
export function ProjectsOverlay({
  projects,
  current,
  cursor,
}: {
  projects: Project[];
  current: string;
  cursor: number;
}) {
  return (
    <List
      title="Projects"
      rows={projects.map((p) => ({
        key: p.root,
        label: `${p.root === current ? '● ' : '  '}${p.name}  ${p.root}`,
      }))}
      cursor={cursor}
      focused
      empty="no running dispatchd found"
    />
  );
}
