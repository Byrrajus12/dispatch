import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// `dispatch-mcp setup`: one command that connects every agent client on this
// machine to Dispatch. It finds the clients installed (Claude Code, Codex,
// Cursor, Gemini CLI, Claude Desktop, Windsurf), adds the Dispatch MCP server
// to each user-wide, installs Claude Code's hooks (mail notices at each
// prompt, a wake-up when an idle session gets mail), and then signs the
// machine in to its team. Safe to run again: it only adds what is missing,
// and never rewrites a config file it cannot parse.

/** How a client should start this server. */
export interface Launch {
  command: string;
  args: string[];
}

export type StepResult =
  | { client: string; status: 'added' | 'present' }
  | { client: string; status: 'skipped'; reason: string };

export interface SetupEnv {
  home: string;
  platform: NodeJS.Platform;
  /** Whether an executable is on PATH. */
  has(binary: string): boolean;
  /** Runs a command, returning its exit status. */
  run(command: string, args: string[]): number | null;
}

export function defaultSetupEnv(): SetupEnv {
  return {
    home: homedir(),
    platform: process.platform,
    has: (binary) =>
      spawnSync(process.platform === 'win32' ? 'where' : 'which', [binary], {
        stdio: 'ignore',
        env: process.env,
      }).status === 0,
    run: (command, args) =>
      spawnSync(command, args, {
        stdio: 'ignore',
        env: process.env,
        timeout: 60_000,
      }).status,
  };
}

/** The launch every client gets: the installed binary when there is one
 *  (fast to start), else npx. */
export function launchFor(env: SetupEnv): Launch {
  return env.has('dispatch-mcp')
    ? { command: 'dispatch-mcp', args: [] }
    : { command: 'npx', args: ['-y', '@dispatch-foo/mcp'] };
}

function readJson(
  path: string
): Record<string, unknown> | null | 'unparseable' {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : 'unparseable';
  } catch {
    return 'unparseable';
  }
}

// The mode a config keeps: its own, or owner-only for a new one, since
// client configs carry other servers' tokens.
function modeOf(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o600;
  }
}

// Through a temp file, so a crash never leaves half a config behind.
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const mode = modeOf(path);
  const temp = `${path}.dispatch-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}

// Adds mcpServers.dispatch to a JSON config (Cursor, Gemini, Claude
// Desktop, Windsurf all share this shape).
function addToJsonConfig(
  client: string,
  path: string,
  launch: Launch
): StepResult {
  const config = readJson(path);
  if (config === 'unparseable')
    return {
      client,
      status: 'skipped',
      reason: `${path} is not plain JSON; add the server by hand`,
    };
  const current = config ?? {};
  const servers =
    typeof current.mcpServers === 'object' && current.mcpServers !== null
      ? (current.mcpServers as Record<string, unknown>)
      : {};
  if (servers.dispatch !== undefined) return { client, status: 'present' };
  writeJson(path, { ...current, mcpServers: { ...servers, dispatch: launch } });
  return { client, status: 'added' };
}

function claudeDesktopConfig(env: SetupEnv): string {
  if (env.platform === 'darwin')
    return join(
      env.home,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
  if (env.platform === 'win32')
    return join(
      process.env.APPDATA ?? join(env.home, 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json'
    );
  return join(env.home, '.config', 'Claude', 'claude_desktop_config.json');
}

// Codex keeps its servers in TOML; Dispatch's is appended as its own table.
function addToCodex(path: string, launch: Launch): StepResult {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (/^\s*\[mcp_servers\.dispatch\]\s*$/m.test(text))
    return { client: 'Codex', status: 'present' };
  const toml = (s: string) => JSON.stringify(s);
  const block =
    `\n[mcp_servers.dispatch]\ncommand = ${toml(launch.command)}\n` +
    `args = [${launch.args.map(toml).join(', ')}]\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${block}`
  );
  return { client: 'Codex', status: 'added' };
}

const HOOK_MARK = ' hook claude ';

/** The Claude Code hooks: the unread line at each prompt, one held stop for
 *  mail to the session, and a background wait that wakes an idle session. */
export function claudeHooks(launch: Launch): Record<string, unknown[]> {
  const base = [launch.command, ...launch.args].join(' ');
  const hook = (event: string) => ({
    type: 'command',
    command: `${base} hook claude ${event}`,
  });
  return {
    UserPromptSubmit: [{ hooks: [hook('UserPromptSubmit')] }],
    Stop: [
      {
        hooks: [
          hook('Stop'),
          {
            ...hook('wait'),
            asyncRewake: true,
            timeout: 3600,
            rewakeMessage: 'Dispatch: another agent sent you mail.',
            rewakeSummary: 'Dispatch mail',
          },
        ],
      },
    ],
  };
}

// Merges the hooks into ~/.claude/settings.json, leaving every other hook
// alone and adding none twice.
function addClaudeHooks(env: SetupEnv, launch: Launch): StepResult {
  const client = 'Claude Code hooks';
  const path = join(env.home, '.claude', 'settings.json');
  const settings = readJson(path);
  if (settings === 'unparseable')
    return { client, status: 'skipped', reason: `${path} is not plain JSON` };
  const current = settings ?? {};
  if (JSON.stringify(current.hooks ?? {}).includes(HOOK_MARK))
    return { client, status: 'present' };
  const hooks =
    typeof current.hooks === 'object' && current.hooks !== null
      ? { ...(current.hooks as Record<string, unknown[]>) }
      : {};
  for (const [event, entries] of Object.entries(claudeHooks(launch)))
    hooks[event] = [
      ...(Array.isArray(hooks[event]) ? hooks[event] : []),
      ...entries,
    ];
  writeJson(path, { ...current, hooks });
  return { client, status: 'added' };
}

/** Installs the server globally (best effort), so clients and hooks start
 *  it instantly instead of through npx; true when it is installed. */
export function installGlobally(env: SetupEnv, version: string): boolean {
  if (env.has('dispatch-mcp')) return true;
  if (!env.has('npm')) return false;
  return (
    env.run('npm', ['install', '--global', `@dispatch-foo/mcp@${version}`]) ===
      0 && env.has('dispatch-mcp')
  );
}

/** Connects every client found on this machine; one result per client. */
export function connectClients(
  env: SetupEnv,
  launch: Launch = launchFor(env)
): StepResult[] {
  const results: StepResult[] = [];
  const home = env.home;

  if (env.has('claude') || existsSync(join(home, '.claude'))) {
    if (!env.has('claude'))
      results.push({
        client: 'Claude Code',
        status: 'skipped',
        reason: 'the claude command is not on PATH',
      });
    else {
      const added = env.run('claude', [
        'mcp',
        'add',
        '-s',
        'user',
        'dispatch',
        '--',
        launch.command,
        ...launch.args,
      ]);
      // A second add fails because the server is there already.
      results.push({
        client: 'Claude Code',
        status: added === 0 ? 'added' : 'present',
      });
    }
    results.push(addClaudeHooks(env, launch));
  }
  if (env.has('codex') || existsSync(join(home, '.codex')))
    results.push(addToCodex(join(home, '.codex', 'config.toml'), launch));
  if (existsSync(join(home, '.cursor')))
    results.push(
      addToJsonConfig('Cursor', join(home, '.cursor', 'mcp.json'), launch)
    );
  if (env.has('gemini') || existsSync(join(home, '.gemini')))
    results.push(
      addToJsonConfig(
        'Gemini CLI',
        join(home, '.gemini', 'settings.json'),
        launch
      )
    );
  if (existsSync(dirname(claudeDesktopConfig(env))))
    results.push(
      addToJsonConfig('Claude Desktop', claudeDesktopConfig(env), launch)
    );
  if (existsSync(join(home, '.codeium', 'windsurf')))
    results.push(
      addToJsonConfig(
        'Windsurf',
        join(home, '.codeium', 'windsurf', 'mcp_config.json'),
        launch
      )
    );
  return results;
}

/** Whether `url` may be opened for a sign-in at `server`: the same origin,
 *  over https (or http to this machine). */
export function safeToOpen(url: string, server: string): boolean {
  try {
    const u = new URL(url);
    const s = new URL(server);
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    return (
      u.origin === s.origin &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && loopback))
    );
  } catch {
    return false;
  }
}

/** Opens a URL in the person's browser, never through a shell; false when
 *  there is no way to. Callers pass only URLs safeToOpen accepts. */
export function openBrowser(url: string): boolean {
  if (process.env.DISPATCH_NO_BROWSER === '1') return false;
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawnSync(command, args, {
      stdio: 'ignore',
      env: process.env,
      timeout: 10_000,
    });
    return child.status === 0;
  } catch {
    return false;
  }
}
