import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sidecarExecutableName } from './build-sidecars.ts';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('sidecarExecutableName', () => {
  test('adds .exe to every Windows sidecar and leaves Unix names unchanged', () => {
    const names = ['dispatchd', 'dispatch-mcp', 'dispatch-cli'];
    expect(names.map((name) => sidecarExecutableName(name, 'win32'))).toEqual([
      'dispatchd.exe',
      'dispatch-mcp.exe',
      'dispatch-cli.exe',
    ]);
    expect(names.map((name) => sidecarExecutableName(name, 'linux'))).toEqual(
      names
    );
    expect(names.map((name) => sidecarExecutableName(name, 'darwin'))).toEqual(
      names
    );
  });
});

test('Tauri keeps Unix resources in the base config and overrides them on Windows', () => {
  const base = JSON.parse(
    readFileSync(resolve(desktopDir, 'src-tauri', 'tauri.conf.json'), 'utf8')
  ) as { bundle: { resources: string[] } };
  const windows = JSON.parse(
    readFileSync(
      resolve(desktopDir, 'src-tauri', 'tauri.windows.conf.json'),
      'utf8'
    )
  ) as { bundle: { resources: string[] } };

  expect(base.bundle.resources).toEqual([
    'resources/dispatchd',
    'resources/dispatch-mcp',
    'resources/dispatch-cli',
  ]);
  expect(windows.bundle.resources).toEqual([
    'resources/dispatchd.exe',
    'resources/dispatch-mcp.exe',
    'resources/dispatch-cli.exe',
  ]);
});

test('desktop:tauri-dev depends on the cacheable sidecar build outputs', () => {
  // Read the task graph structurally rather than by regex over the file, so a
  // reworded comment or a new task between the two cannot break this test.
  const { tasks } = Bun.YAML.parse(
    readFileSync(resolve(desktopDir, 'moon.yml'), 'utf8')
  ) as {
    tasks: Record<
      string,
      {
        deps?: string[];
        inputs?: string[];
        outputs?: string[];
        options?: { cache?: boolean };
      }
    >;
  };
  const sidecars = tasks['build-sidecars'];
  const tauriDev = tasks['tauri-dev'];

  expect(sidecars.outputs).toEqual([
    'src-tauri/resources/dispatchd*',
    'src-tauri/resources/dispatch-mcp*',
    'src-tauri/resources/dispatch-cli*',
  ]);
  // The two inputs that change the binaries without touching any source: the
  // signing identity and the entitlements the sidecars are signed with.
  expect(sidecars.inputs).toContain('$APPLE_SIGNING_IDENTITY');
  expect(sidecars.inputs).toContain('src-tauri/entitlements/sidecar.plist');
  expect(sidecars.options?.cache).not.toBe(false);
  expect(tauriDev.deps).toContain('build-sidecars');
});
