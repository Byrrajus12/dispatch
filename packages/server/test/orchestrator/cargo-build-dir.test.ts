import { describe, expect, test } from 'bun:test';

import {
  cargoBuildDir,
  shareCargoBuildDir,
  worktreesDir,
} from '../../src/orchestrator/paths.js';

describe('shareCargoBuildDir', () => {
  test('points an unset CARGO_BUILD_BUILD_DIR at the project-wide directory', () => {
    const env: Record<string, string | undefined> = {};
    shareCargoBuildDir('/repo/a', env);
    expect(env.CARGO_BUILD_BUILD_DIR).toBe(cargoBuildDir('/repo/a'));
  });

  test('leaves CARGO_TARGET_DIR alone so binaries stay in the worktree', () => {
    const env: Record<string, string | undefined> = {};
    shareCargoBuildDir('/repo/a', env);
    expect(env.CARGO_TARGET_DIR).toBeUndefined();
  });

  test('treats an empty value as unset', () => {
    const env: Record<string, string | undefined> = {
      CARGO_BUILD_BUILD_DIR: '',
      CARGO_TARGET_DIR: '',
    };
    shareCargoBuildDir('/repo/a', env);
    expect(env.CARGO_BUILD_BUILD_DIR).toBe(cargoBuildDir('/repo/a'));
  });

  test('keeps a CARGO_BUILD_BUILD_DIR the user already chose', () => {
    const env: Record<string, string | undefined> = {
      CARGO_BUILD_BUILD_DIR: '/mine',
    };
    shareCargoBuildDir('/repo/a', env);
    expect(env.CARGO_BUILD_BUILD_DIR).toBe('/mine');
  });

  test('stays out of the way of a CARGO_TARGET_DIR the user already chose', () => {
    const env: Record<string, string | undefined> = {
      CARGO_TARGET_DIR: '/mine',
    };
    shareCargoBuildDir('/repo/a', env);
    expect(env.CARGO_BUILD_BUILD_DIR).toBeUndefined();
    expect(env.CARGO_TARGET_DIR).toBe('/mine');
  });

  test('is per project and outside every run worktree', () => {
    expect(cargoBuildDir('/repo/a')).not.toBe(cargoBuildDir('/repo/b'));
    expect(cargoBuildDir('/repo/a').startsWith(worktreesDir('/repo/a'))).toBe(
      false
    );
  });
});
