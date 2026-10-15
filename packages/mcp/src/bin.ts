#!/usr/bin/env node
import { parseRootArg } from './argv.js';
import type { HookClient } from './hook.js';
import {
  HOOK_CLIENTS,
  hookConfigText,
  runHook,
  WAIT_TIMEOUT_SEC,
  waitForMail,
} from './hook.js';
import { runStdioServer } from './server.js';

const argv = process.argv.slice(2);

// `hook <client> <event>` runs as an agent client's hook: it must print
// valid hook output or nothing, and never fail the client's turn.
if (argv[0] === 'hook') {
  const client = argv[1] as HookClient;
  // `hook claude wait` runs in the background (asyncRewake): it exits 2 with
  // the wake line on stderr when mail arrives, else 0 when its time is up.
  if (client === 'claude' && argv[2] === 'wait') {
    const line = await waitForMail(await readStdin(), process.cwd(), {
      timeoutMs: (WAIT_TIMEOUT_SEC - 30) * 1000,
      pollMs: 3000,
    }).catch(() => null);
    if (line !== null) {
      process.stderr.write(`${line}\n`);
      process.exit(2);
    }
    process.exit(0);
  }
  if (HOOK_CLIENTS.includes(client) && argv[2] !== undefined) {
    const input = await readStdin();
    const output = await runHook(client, argv[2], input, process.cwd()).catch(
      () => ''
    );
    if (output !== '') process.stdout.write(`${output}\n`);
  }
  process.exit(0);
}

if (argv[0] === 'hooks') {
  const client = argv[1] as HookClient;
  if (!HOOK_CLIENTS.includes(client)) {
    console.error(`usage: dispatch-mcp hooks <${HOOK_CLIENTS.join('|')}>`);
    process.exit(1);
  }
  process.stdout.write(hookConfigText(client));
  process.exit(0);
}

// `login` signs this machine in to a team: every agent on it can then reach
// every teammate's agents.
if (argv[0] === 'login') {
  const { startDeviceLogin } = await import('./login.js');
  const started = await startDeviceLogin();
  if ('error' in started) {
    console.error(`dispatch-mcp login: ${started.error}`);
    process.exit(1);
  }
  console.log(
    `Open ${started.verificationUriComplete}\nand confirm the code ${started.userCode}.`
  );
  const result = await started.done;
  if (!result.ok) {
    console.error(`dispatch-mcp login: ${result.error}`);
    process.exit(1);
  }
  console.log(
    `Signed in to ${result.team.team.name} as ${result.team.handle}. Your agents can now reach your teammates'.`
  );
  process.exit(0);
}

// `hub` runs the machine hub in the foreground; MCP servers start it detached.
if (argv[0] === 'hub') {
  const { runHub } = await import('./hub/main.js');
  await runHub();
  process.exit(0);
}

const parsed = parseRootArg(argv);
if (!parsed.ok) {
  console.error(`dispatch-mcp: ${parsed.error}`);
  process.exit(1);
}

await runStdioServer(parsed.root);

// All of stdin, or '' when it is a terminal (a hook run by hand).
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
