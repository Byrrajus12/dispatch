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
  waitForMail,
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

  it('has Claude Code wait in the background to wake an idle session', () => {
    const stop = (hookConfig('claude').hooks as Record<string, unknown[]>).Stop;
    const hooks = (stop[0] as { hooks: Record<string, unknown>[] }).hooks;
    expect(hooks[1]).toMatchObject({
      command: 'npx -y @dispatch-foo/mcp hook claude wait',
      asyncRewake: true,
      timeout: 3600,
    });
    expect(JSON.stringify(hookConfig('codex'))).not.toContain('asyncRewake');
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

describe('waitForMail', () => {
  let home: string;
  let root: string;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let items: unknown[];
  const saved = process.env.DISPATCH_HOME;

  const item = (id: string, via: 'direct' | 'channel') => ({
    delivery: { id, state: 'notified', via },
    message: { id: `m-${id}`, from: 'agent:wyat/codex-19be04', body: 'hi' },
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dispatch-wait-home-'));
    root = mkdtempSync(join(tmpdir(), 'dispatch-wait-root-'));
    process.env.DISPATCH_HOME = home;
    items = [];
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ items }),
    });
    const daemonFile = daemonFilePath(root);
    mkdirSync(dirname(daemonFile), { recursive: true });
    writeFileSync(
      daemonFile,
      JSON.stringify({ port: server.port, pid: process.pid, rootDir: root })
    );
    const session = sessionTokenFilePath(
      root,
      sessionName('claude-code', 'wait-session')
    );
    mkdirSync(dirname(session), { recursive: true });
    writeFileSync(
      session,
      JSON.stringify({ token: 't', address: 'agent:w/me', parent: 'agent:w/p' })
    );
  });

  afterEach(() => {
    void server?.stop(true);
    if (saved === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = saved;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const input = () => JSON.stringify({ session_id: 'wait-session', cwd: root });

  it('wakes for direct mail that arrives while it waits', async () => {
    setTimeout(() => {
      items = [item('d-new', 'direct')];
    }, 60);
    const line = await waitForMail(input(), '/', {
      timeoutMs: 2000,
      pollMs: 20,
    });
    expect(line).toBe(
      '[dispatch] 1 unread (from agent:wyat/codex-19be04). Call inbox_read. Read it now.'
    );
  });

  it('does not wake again for mail that was already unread', async () => {
    items = [item('d-old', 'direct')];
    expect(
      await waitForMail(input(), '/', { timeoutMs: 150, pollMs: 20 })
    ).toBeNull();
  });

  it('does not wake for channel traffic', async () => {
    setTimeout(() => {
      items = [item('d-chan', 'channel')];
    }, 40);
    expect(
      await waitForMail(input(), '/', { timeoutMs: 200, pollMs: 20 })
    ).toBeNull();
  });

  it('stands down when a newer wait takes the session over', async () => {
    const first = waitForMail(input(), '/', { timeoutMs: 5000, pollMs: 20 });
    await Bun.sleep(60);
    // A second wait in another process would write its own pid to the claim.
    const claim = `${sessionTokenFilePath(root, sessionName('claude-code', 'wait-session'))}.wait`;
    writeFileSync(claim, '999999');
    const started = Date.now();
    expect(await first).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('gives up at once for a session it cannot find', async () => {
    const started = Date.now();
    expect(
      await waitForMail(
        JSON.stringify({ session_id: 'nobody', cwd: root }),
        '/',
        {
          timeoutMs: 5000,
          pollMs: 20,
        }
      )
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
