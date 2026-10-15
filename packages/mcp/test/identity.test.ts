import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { daemonFilePath } from '../src/daemon.js';
import {
  agentName,
  agentTokenFilePath,
  currentBranch,
  existingMessagingCredential,
  forgetAgentToken,
  messagingCredential,
  sessionKey,
  sessionName,
  sessionsEnabled,
  sessionTokenFilePath,
} from '../src/identity.js';

interface SessionCall {
  name: string;
  client: string;
  parent: string;
  parentToken: string;
  meta: Record<string, string>;
}

// A minimal stand-in for dispatchd's registration route — just enough to
// drive messagingCredential's self-registration path deterministically.
class FakeDaemon {
  registerStatus = 201;
  registerBody: unknown = {
    address: 'agent:wyat/claude-code.some-host',
    token: 'freshly-minted-token',
    status: 'pending',
  };
  registerCalls: { name: string; client: string; rekey?: boolean }[] = [];
  /** Session registrations (bodies with a parent); refused by default, as
   *  for a client identity still awaiting approval. */
  sessionCalls: SessionCall[] = [];
  sessionStatus = 403;
  sessionBody: unknown = { error: 'parent is not approved' };
  /** Delays the register response, to widen the window for a concurrent
   *  call's in-flight dedup to actually observe this one still pending. */
  registerDelayMs = 0;
  /** Runs as each register request arrives, before the response: lets a test
   *  finish a parallel process's registration while this one is in flight. */
  onRegisterRequest: (() => void) | null = null;
  private server: ReturnType<typeof Bun.serve> | undefined;

  start(): number {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/api/health') return Response.json({ ok: true });
        if (url.pathname === '/api/agents/register' && req.method === 'POST') {
          if (
            req.headers.get('authorization') !== 'Bearer shared-agent-token'
          ) {
            return Response.json({ error: 'unauthorized' }, { status: 401 });
          }
          const body = (await req.json()) as {
            name: string;
            client: string;
            parent?: string;
          };
          if (body.parent !== undefined) {
            this.sessionCalls.push(body as SessionCall);
            return Response.json(this.sessionBody, {
              status: this.sessionStatus,
            });
          }
          this.registerCalls.push(body);
          this.onRegisterRequest?.();
          if (this.registerDelayMs > 0) {
            await new Promise((r) => setTimeout(r, this.registerDelayMs));
          }
          return Response.json(this.registerBody, {
            status: this.registerStatus,
          });
        }
        return Response.json({ error: 'not found' }, { status: 404 });
      },
    });
    return this.server.port ?? 0;
  }

  stop(): void {
    void this.server?.stop(true);
  }
}

let fakeHome: string;
let root: string;
let daemon: FakeDaemon | undefined;
const originalEnv = {
  DISPATCH_HOME: process.env.DISPATCH_HOME,
  DISPATCH_RUN_TOKEN: process.env.DISPATCH_RUN_TOKEN,
  DISPATCH_RUN_TOKEN_FILE: process.env.DISPATCH_RUN_TOKEN_FILE,
  DISPATCH_RUN_ID: process.env.DISPATCH_RUN_ID,
  DISPATCH_AGENT_NAME: process.env.DISPATCH_AGENT_NAME,
  DISPATCH_SESSIONS: process.env.DISPATCH_SESSIONS,
  DISPATCH_SESSION_ID: process.env.DISPATCH_SESSION_ID,
  CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
  CODEX_SESSION_ID: process.env.CODEX_SESSION_ID,
  GEMINI_SESSION_ID: process.env.GEMINI_SESSION_ID,
};

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-mcp-identity-home-'));
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-identity-root-'));
  process.env.DISPATCH_HOME = fakeHome;
  delete process.env.DISPATCH_RUN_TOKEN;
  delete process.env.DISPATCH_RUN_TOKEN_FILE;
  delete process.env.DISPATCH_RUN_ID;
  delete process.env.DISPATCH_AGENT_NAME;
  delete process.env.DISPATCH_SESSIONS;
  // The test runner may itself run inside an agent session.
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
  delete process.env.GEMINI_SESSION_ID;
  process.env.DISPATCH_SESSION_ID = 'test-session';
});

afterEach(() => {
  daemon?.stop();
  daemon = undefined;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function writeFakeDaemonFile(forRoot: string, port: number): void {
  const path = daemonFilePath(forRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      port,
      pid: process.pid,
      rootDir: forRoot,
      startedAt: new Date().toISOString(),
      agentToken: 'shared-agent-token',
    })
  );
}

describe('agentName', () => {
  it('joins the client name and short hostname, normalized like the server does', () => {
    expect(agentName({}, 'Claude Code', 'Wyats-MacBook-Pro.local')).toBe(
      'claude-code.wyats-macbook-pro'
    );
  });

  it('DISPATCH_AGENT_NAME overrides the computed name', () => {
    expect(
      agentName(
        { DISPATCH_AGENT_NAME: 'My Custom Bot' },
        'Claude Code',
        'Wyats-MacBook-Pro.local'
      )
    ).toBe('my-custom-bot');
  });

  it('falls back to "agent" when no client name is known', () => {
    expect(agentName({}, undefined, 'host.local')).toBe('agent.host');
  });

  it('trims leading characters a handle cannot start with', () => {
    expect(
      agentName({ DISPATCH_AGENT_NAME: '  -Bot' }, 'Claude Code', 'host.local')
    ).toBe('bot');
  });

  it('caps the name at 40 characters', () => {
    expect(
      agentName(
        { DISPATCH_AGENT_NAME: 'x'.repeat(50) },
        'Claude Code',
        'host.local'
      )
    ).toBe('x'.repeat(40));
    expect(
      agentName(
        {},
        'A Very Long Client Name For Testing',
        'Wyats-MacBook-Pro.local'
      )
    ).toBe('a-very-long-client-name-for-testing.wyat');
  });
});

describe('messagingCredential (run context)', () => {
  it('reads the token from the file DISPATCH_RUN_TOKEN_FILE names and derives the run address from DISPATCH_RUN_ID', async () => {
    const file = join(fakeHome, 'r-self1.token');
    writeFileSync(file, 'rt-abc123\n', { mode: 0o600 });
    process.env.DISPATCH_RUN_TOKEN_FILE = file;
    process.env.DISPATCH_RUN_ID = 'r-self1';
    const result = await messagingCredential(root, 'Claude Code');
    expect(result).toEqual({
      token: 'rt-abc123',
      kind: 'run',
      address: 'run:r-self1',
    });
  });

  it('never reads a token from DISPATCH_RUN_TOKEN in env', async () => {
    process.env.DISPATCH_RUN_TOKEN = 'rt-from-env';
    process.env.DISPATCH_RUN_ID = 'r-self1';
    const name = agentName(process.env, 'Claude Code', hostname());
    const path = agentTokenFilePath(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ token: 'cached-agent-token', address: 'agent:wyat/x' })
    );

    const result = await messagingCredential(root, 'Claude Code');
    expect(result).toEqual({
      token: 'cached-agent-token',
      address: 'agent:wyat/x',
      kind: 'agent',
    });
  });

  it('errors instead of self-registering when the run token file is unreadable', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(root, daemon.start());
    const file = join(fakeHome, 'gone.token');
    process.env.DISPATCH_RUN_TOKEN_FILE = file;
    process.env.DISPATCH_RUN_ID = 'r-self1';

    const result = await messagingCredential(root, 'Claude Code');
    expect(result).toEqual({
      error: expect.stringContaining(`cannot read this run's token (${file})`),
    });
    expect(daemon.registerCalls).toEqual([]);
  });
});

describe('messagingCredential (cached agent token)', () => {
  it('reads an already-registered agent token and address straight from disk, no daemon needed', async () => {
    const name = agentName(process.env, 'Claude Code', hostname());
    const path = agentTokenFilePath(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ token: 'cached-token-value', address: 'agent:wyat/x' })
    );

    const result = await messagingCredential(root, 'Claude Code');
    expect(result).toEqual({
      token: 'cached-token-value',
      address: 'agent:wyat/x',
      kind: 'agent',
    });
  });

  it('treats a corrupt cache file as absent rather than throwing', async () => {
    const name = agentName(process.env, 'Claude Code', hostname());
    const path = agentTokenFilePath(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not json');

    const result = await messagingCredential(root, 'Claude Code');
    expect(result).toEqual({
      error: expect.stringContaining('dispatchd not running'),
    });
  });
});

describe('messagingCredential (unreadable cache)', () => {
  it('moves an unreadable cache aside and re-keys the same name, keeping the last 3 copies', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(root, daemon.start());
    const name = agentName(process.env, 'Claude Code', hostname());
    const path = agentTokenFilePath(root, name);
    mkdirSync(dirname(path), { recursive: true });
    for (let i = 0; i < 4; i++)
      writeFileSync(`${path}.corrupt-${1000 + i}`, 'old');
    writeFileSync(path, '{"token": "trunc');

    const result = await messagingCredential(root, 'Claude Code');
    expect(result).toMatchObject({ token: 'freshly-minted-token' });
    expect(daemon.registerCalls).toEqual([
      { name, client: 'Claude Code', rekey: true },
    ]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      token: 'freshly-minted-token',
    });
    const aside = readdirSync(dirname(path)).filter((f) =>
      f.includes('.corrupt-')
    );
    expect(aside).toHaveLength(3);
    expect(aside).not.toContain(`${name}.json.corrupt-1000`);
    expect(readdirSync(dirname(path)).some((f) => f.includes('.tmp'))).toBe(
      false
    );
  });
});

describe('messagingCredential (per-project caching)', () => {
  it('registers and caches a separate token file per project root', async () => {
    const rootB = mkdtempSync(join(tmpdir(), 'dispatch-mcp-identity-root-b-'));
    try {
      daemon = new FakeDaemon();
      const port = daemon.start();
      writeFakeDaemonFile(root, port);
      writeFakeDaemonFile(rootB, port);

      const credA = await messagingCredential(root, 'Claude Code');
      const credB = await messagingCredential(rootB, 'Claude Code');

      expect(daemon.registerCalls.length).toBe(2);
      const name = agentName(process.env, 'Claude Code', hostname());
      const pathA = agentTokenFilePath(root, name);
      const pathB = agentTokenFilePath(rootB, name);
      expect(pathA).not.toBe(pathB);
      expect(existsSync(pathA)).toBe(true);
      expect(existsSync(pathB)).toBe(true);
      expect(credA).toEqual({
        token: 'freshly-minted-token',
        address: 'agent:wyat/claude-code.some-host',
        kind: 'agent',
      });
      expect(credB).toEqual(credA);
    } finally {
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});

describe('messagingCredential (self-registration)', () => {
  it('reports a clear error when no daemon is reachable to register with', async () => {
    const result = await messagingCredential(root, 'Claude Code');
    expect(result).toEqual({
      error: expect.stringContaining('dispatchd not running'),
    });
  });

  it('registers a fresh agent identity and writes its token+address to disk at 0600', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(root, daemon.start());

    const result = await messagingCredential(root, 'Claude Code');
    expect(result).toEqual({
      token: 'freshly-minted-token',
      address: 'agent:wyat/claude-code.some-host',
      kind: 'agent',
    });

    const name = agentName(process.env, 'Claude Code', hostname());
    expect(daemon.registerCalls).toEqual([{ name, client: 'Claude Code' }]);

    const path = agentTokenFilePath(root, name);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      token: 'freshly-minted-token',
      address: 'agent:wyat/claude-code.some-host',
    });
    // 0600 — owner read/write only, since this is a bearer credential.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // 0700 on the per-project directory it lives in, for the same reason.
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  });

  it('surfaces accurate 409 guidance: revoke, then delete the cache file', async () => {
    daemon = new FakeDaemon();
    daemon.registerStatus = 409;
    daemon.registerBody = {
      error: 'agent:wyat/claude-code.some-host is already registered (pending)',
    };
    writeFakeDaemonFile(root, daemon.start());

    const result = await messagingCredential(root, 'Claude Code');
    const name = agentName(process.env, 'Claude Code', hostname());
    const path = agentTokenFilePath(root, name);
    expect(result).toEqual({
      error: `${name} is already registered; revoke it in Dispatch → Settings → Agents, then delete ${path}`,
    });
  });

  it('re-checks the cache on a 409 instead of failing when a parallel registration just landed', async () => {
    daemon = new FakeDaemon();
    daemon.registerStatus = 409;
    const name = agentName(process.env, 'Claude Code', hostname());
    const path = agentTokenFilePath(root, name);
    daemon.onRegisterRequest = () => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ token: 'raced-in-token', address: 'agent:wyat/raced' })
      );
    };
    writeFakeDaemonFile(root, daemon.start());

    const result = await messagingCredential(root, 'Claude Code');
    expect(result).toEqual({
      token: 'raced-in-token',
      address: 'agent:wyat/raced',
      kind: 'agent',
    });
  });

  it('memoizes concurrent registrations for the same project+name into one request', async () => {
    daemon = new FakeDaemon();
    daemon.registerDelayMs = 50;
    writeFakeDaemonFile(root, daemon.start());

    const [a, b] = await Promise.all([
      messagingCredential(root, 'Claude Code'),
      messagingCredential(root, 'Claude Code'),
    ]);
    expect(daemon.registerCalls.length).toBe(1);
    expect(a).toEqual(b);
  });
});

describe('forgetAgentToken', () => {
  it('deletes the cache file only while it still holds the rejected token', () => {
    const name = agentName(process.env, 'Claude Code', hostname());
    const path = agentTokenFilePath(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ token: 'fresh-token', address: 'agent:wyat/x' })
    );

    forgetAgentToken(root, name, 'stale-token');
    expect(existsSync(path)).toBe(true);

    forgetAgentToken(root, name, 'fresh-token');
    expect(existsSync(path)).toBe(false);
  });
});

describe('sessions', () => {
  it('takes the most specific session id the environment offers', () => {
    expect(
      sessionKey({ CLAUDE_CODE_SESSION_ID: 'c', DISPATCH_SESSION_ID: 'd' })
    ).toBe('d');
    expect(sessionKey({ CODEX_SESSION_ID: 'x', GEMINI_SESSION_ID: 'g' })).toBe(
      'x'
    );
    expect(sessionKey({})).toBe(sessionKey({}));
    expect(sessionKey({})).not.toBe('');
  });

  it('names a session <client>-<6 hex>, stable for one key', () => {
    const name = sessionName('Claude Code', 'abc');
    expect(name).toMatch(/^claude-code-[0-9a-f]{6}$/);
    expect(sessionName('Claude Code', 'abc')).toBe(name);
    expect(sessionName('Claude Code', 'abd')).not.toBe(name);
    expect(sessionName(undefined, 'abc')).toMatch(/^agent-[0-9a-f]{6}$/);
  });

  it('is off for a fixed agent name or DISPATCH_SESSIONS=0', () => {
    expect(sessionsEnabled({})).toBe(true);
    expect(sessionsEnabled({ DISPATCH_AGENT_NAME: 'reviewer' })).toBe(false);
    expect(sessionsEnabled({ DISPATCH_SESSIONS: '0' })).toBe(false);
  });

  it('reads the branch from HEAD, through a worktree .git file too', () => {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/feat/x\n');
    expect(currentBranch(repo)).toBe('feat/x');

    const wt = join(root, 'wt');
    const wtGit = join(root, 'wt-git');
    mkdirSync(wt);
    mkdirSync(wtGit);
    writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/side\n');
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`);
    expect(currentBranch(wt)).toBe('side');

    writeFileSync(join(wtGit, 'HEAD'), 'deadbeef\n');
    expect(currentBranch(wt)).toBeUndefined();
    expect(currentBranch(join(root, 'nowhere'))).toBeUndefined();
  });

  it('speaks as the client identity while the daemon will not vouch for a session', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(root, daemon.start());
    const cred = await messagingCredential(root, 'Claude Code');
    expect(cred).toEqual({
      token: 'freshly-minted-token',
      address: 'agent:wyat/claude-code.some-host',
      kind: 'agent',
    });
    expect(daemon.sessionCalls).toHaveLength(1);
    // Refused once, it waits before asking again.
    await messagingCredential(root, 'Claude Code');
    expect(daemon.sessionCalls).toHaveLength(1);
  });

  it('registers and caches a session under an approved client identity', async () => {
    daemon = new FakeDaemon();
    daemon.sessionStatus = 201;
    daemon.sessionBody = {
      address: 'agent:wyat/claude-code-aaaaaa',
      token: 'session-token',
      status: 'approved',
    };
    writeFakeDaemonFile(root, daemon.start());
    process.env.DISPATCH_SESSION_ID = 'approved-session';

    const cred = await messagingCredential(root, 'Claude Code');
    expect(cred).toEqual({
      token: 'session-token',
      address: 'agent:wyat/claude-code-aaaaaa',
      kind: 'agent',
      parent: 'agent:wyat/claude-code.some-host',
    });
    const [call] = daemon.sessionCalls;
    expect(call.name).toBe(sessionName('Claude Code', 'approved-session'));
    expect(call.parent).toBe('agent:wyat/claude-code.some-host');
    expect(call.parentToken).toBe('freshly-minted-token');
    expect(call.meta.kind).toBe('session');
    expect(call.meta.cwd).toBe(root);

    const path = sessionTokenFilePath(root, call.name);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existingMessagingCredential(root, 'Claude Code')).toEqual(cred);
    await messagingCredential(root, 'Claude Code');
    expect(daemon.sessionCalls).toHaveLength(1);
  });

  it('never registers a session for a fixed agent name', async () => {
    daemon = new FakeDaemon();
    daemon.sessionStatus = 201;
    writeFakeDaemonFile(root, daemon.start());
    process.env.DISPATCH_AGENT_NAME = 'reviewer';
    await messagingCredential(root, 'Claude Code');
    expect(daemon.sessionCalls).toHaveLength(0);
  });
});
