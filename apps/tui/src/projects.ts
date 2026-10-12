import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface Project {
  name: string;
  root: string;
  port: number;
  agentToken: string;
}

/** Projects with a running dispatchd, from its daemon files under `<home>/.dispatch/daemons`. */
export function listProjects(home: string): Project[] {
  const dir = join(home, '.dispatch', 'daemons');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const projects: Project[] = [];
  for (const name of names) {
    try {
      const info = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        rootDir?: unknown;
        port?: unknown;
        agentToken?: unknown;
      };
      if (
        typeof info.rootDir === 'string' &&
        typeof info.port === 'number' &&
        typeof info.agentToken === 'string'
      ) {
        projects.push({
          name: basename(info.rootDir),
          root: info.rootDir,
          port: info.port,
          agentToken: info.agentToken,
        });
      }
    } catch {
      // A file mid-write or from an older daemon; the next look will see it right.
    }
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}
