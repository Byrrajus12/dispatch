import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listProjects } from '../src/projects';

function home(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tui-home-'));
  const daemons = join(dir, '.dispatch', 'daemons');
  mkdirSync(daemons, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(
      join(daemons, name),
      typeof body === 'string' ? body : JSON.stringify(body)
    );
  }
  return dir;
}

describe('listProjects', () => {
  test('lists every daemon file with a root, port and token, by project name', () => {
    const dir = home({
      'a.json': { rootDir: '/code/zeta', port: 4001, pid: 1, agentToken: 'ta' },
      'b.json': {
        rootDir: '/code/alpha',
        port: 4002,
        pid: 2,
        agentToken: 'tb',
      },
    });
    expect(listProjects(dir)).toEqual([
      { name: 'alpha', root: '/code/alpha', port: 4002, agentToken: 'tb' },
      { name: 'zeta', root: '/code/zeta', port: 4001, agentToken: 'ta' },
    ]);
  });

  test('skips corrupt files and daemons that predate tokens', () => {
    const dir = home({
      'bad.json': '{nope',
      'old.json': { rootDir: '/code/old', port: 1, pid: 1 },
      'ok.json': { rootDir: '/code/ok', port: 2, pid: 2, agentToken: 't' },
    });
    expect(listProjects(dir).map((p) => p.name)).toEqual(['ok']);
  });

  test('no daemons directory means no projects', () => {
    expect(listProjects(mkdtempSync(join(tmpdir(), 'tui-empty-')))).toEqual([]);
  });
});
