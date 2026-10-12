import { describe, expect, test } from 'bun:test';

import {
  cargoTargetDir,
  shareCargoTargetDir,
  worktreesDir,
} from '../../src/orchestrator/paths.js';

describe('shareCargoTargetDir', () => {
  test('points an unset CARGO_TARGET_DIR at the project-wide directory', () => {
    const env: Record<string, string | undefined> = {};
    shareCargoTargetDir('/repo/a', env);
    expect(env.CARGO_TARGET_DIR).toBe(cargoTargetDir('/repo/a'));
  });

  test('treats an empty value as unset', () => {
    const env: Record<string, string | undefined> = { CARGO_TARGET_DIR: '' };
    shareCargoTargetDir('/repo/a', env);
    expect(env.CARGO_TARGET_DIR).toBe(cargoTargetDir('/repo/a'));
  });

  test('keeps a CARGO_TARGET_DIR the user already chose', () => {
    const env: Record<string, string | undefined> = {
      CARGO_TARGET_DIR: '/mine',
    };
    shareCargoTargetDir('/repo/a', env);
    expect(env.CARGO_TARGET_DIR).toBe('/mine');
  });

  test('is per project and outside every run worktree', () => {
    expect(cargoTargetDir('/repo/a')).not.toBe(cargoTargetDir('/repo/b'));
    expect(cargoTargetDir('/repo/a').startsWith(worktreesDir('/repo/a'))).toBe(
      false
    );
  });
});
