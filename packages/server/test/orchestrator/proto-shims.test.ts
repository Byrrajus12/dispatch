import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultCommandRunner } from '../../src/orchestrator/pr.js';
import { withProtoShims } from '../../src/orchestrator/protoShims.js';

let scratch: string;
let worktree: string;
let protoHome: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dispatch-proto-shims-'));
  worktree = join(scratch, 'worktree');
  protoHome = join(scratch, "proto home's");
  mkdirSync(worktree);
  mkdirSync(join(protoHome, 'shims'), { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('withProtoShims', () => {
  it('leaves the command alone when the worktree has no .prototools', () => {
    const env = { PROTO_HOME: protoHome };
    expect(withProtoShims(worktree, 'pnpm install', env)).toBe('pnpm install');
  });

  it('leaves the command alone when proto is not installed', () => {
    writeFileSync(join(worktree, '.prototools'), 'pnpm = "11.9.0"\n');
    const env = { PROTO_HOME: join(scratch, 'missing') };
    expect(withProtoShims(worktree, 'pnpm install', env)).toBe('pnpm install');
  });

  // The regression itself: under `bash -lc`, macOS path_helper puts
  // /usr/local/bin (Homebrew pnpm 12) back in front of the daemon's PATH, so
  // the shims have to be prepended inside the shell, after the profile ran.
  it('runs the pinned tool from proto shims even under a login shell', async () => {
    writeFileSync(join(worktree, '.prototools'), 'pnpm = "11.9.0"\n');
    const fakePnpm = join(protoHome, 'shims', 'pnpm');
    writeFileSync(fakePnpm, '#!/bin/sh\necho proto-pnpm\n');
    chmodSync(fakePnpm, 0o755);

    const command = withProtoShims(worktree, 'pnpm', {
      PROTO_HOME: protoHome,
    });
    const result = await defaultCommandRunner(worktree, [
      'bash',
      '-lc',
      command,
    ]);

    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe('proto-pnpm');
  });
});
