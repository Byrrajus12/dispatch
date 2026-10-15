import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { daemonFilePath } from '../src/daemon.js';
import {
  findSessionFile,
  hookConfig,
  hookOutput,
  runHook,
} from '../src/hook.js';
import { sessionName, sessionTokenFilePath } from '../src/identity.js';

const mail = { count: 2, direct: 1, from: ['agent:wyat/codex-19be04'] };
const line =
  '[dispatch] 2 unread (from agent:wyat/codex-19be04). Call inbox_read.';

describe('hookOutput', () => {
  it('adds context on prompt and tool events', () => {
    expect(hookOutput('claude', 'UserPromptSubmit', {}, mail)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: line,
      },
    });
    expect(hookOutput('gemini', 'BeforeAgent', {}, mail)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'BeforeAgent',
        additionalContext: line,
      },
    });
  });

  it('prints nothing with no mail', () => {
    expect(hookOutput('claude', 'UserPromptSubmit', {}, null)).toBeNull();
    expect(
      hookOutput('claude', 'Stop', {}, { count: 0, direct: 0, from: [] })
    ).toBeNull();
  });

  it('skips dispatch tools, whose results carry the line already', () => {
    expect(
      hookOutput(
        'claude',
        'PostToolUse',
        { tool_name: 'mcp__dispatch__task_list' },
        mail
      )
    ).toBeNull();
  });

  it('blocks a stop once, only for mail to this session', () => {
    expect(hookOutput('claude', 'Stop', {}, mail)).toEqual({
      decision: 'block',
      reason: `${line} Read it before you finish.`,
    });
    expect(hookOutput('gemini', 'AfterAgent', {}, mail)?.decision).toBe('deny');
    expect(
      hookOutput('claude', 'Stop', { stop_hook_active: true }, mail)
    ).toBeNull();
    expect(hookOutput('codex', 'Stop', {}, { ...mail, direct: 0 })).toBeNull();
  });

  it('configures prompt and stop hooks for each client', () => {
    expect(Object.keys(hookConfig('claude').hooks as object)).toEqual([
      'UserPromptSubmit',
      'Stop',
    ]);
    expect(JSON.stringify(hookConfig('gemini'))).toContain(
      'hook gemini AfterAgent'
    );
  });
});

describe('runHook', () => {
  let home: string;
  let root: string;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let seenAuth: string | null;
  const saved = process.env.DISPATCH_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dispatch-hook-home-'));
    root = mkdtempSync(join(tmpdir(), 'dispatch-hook-root-'));
    process.env.DISPATCH_HOME = home;
    seenAuth = null;
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        seenAuth = req.headers.get('authorization');
        return Response.json({
          items: [
            {
              delivery: { id: 'd-1', state: 'notified', via: 'direct' },
              message: {
                id: 'm-1',
                from: 'agent:wyat/codex-19be04',
                body: 'hi',
              },
            },
          ],
        });
      },
    });
    const path = daemonFilePath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ port: server.port, pid: process.pid, rootDir: root })
    );
  });

  afterEach(() => {
    void server?.stop(true);
    if (saved === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = saved;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function cacheSession(client: string, key: string): void {
    const path = sessionTokenFilePath(root, sessionName(client, key));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        token: 'session-token',
        address: 'agent:wyat/x',
        parent: 'agent:wyat/claude-code.host',
      })
    );
  }

  it('finds the session by its hook session_id, whatever its client', async () => {
    cacheSession('claude-code', 'sess-1');
    expect(findSessionFile(root, 'sess-1')).not.toBeNull();
    expect(findSessionFile(root, 'sess-2')).toBeNull();

    const out = await runHook(
      'claude',
      'Stop',
      JSON.stringify({ session_id: 'sess-1', cwd: root }),
      '/'
    );
    expect(seenAuth).toBe('Bearer session-token');
    expect(JSON.parse(out)).toEqual({
      decision: 'block',
      reason:
        '[dispatch] 1 unread (from agent:wyat/codex-19be04). Call inbox_read. Read it before you finish.',
    });
  });

  it('prints nothing for a session it cannot find, or bad input', async () => {
    expect(
      await runHook(
        'claude',
        'Stop',
        JSON.stringify({ session_id: 'nope', cwd: root }),
        '/'
      )
    ).toBe('');
    expect(await runHook('codex', 'Stop', 'not json', root)).toBe('');
    expect(seenAuth).toBeNull();
  });
});
