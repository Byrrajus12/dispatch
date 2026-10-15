#!/usr/bin/env node
import { parseRootArg } from './argv.js';
import type { HookClient } from './hook.js';
import { HOOK_CLIENTS, hookConfigText, runHook } from './hook.js';
import { runStdioServer } from './server.js';

const argv = process.argv.slice(2);

// `hook <client> <event>` runs as an agent client's hook: it must print
// valid hook output or nothing, and never fail the client's turn.
if (argv[0] === 'hook') {
  const client = argv[1] as HookClient;
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
