import { createApiClient } from '@dispatch/client';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { TuiRoot } from './App';
import { parseArgs } from './args';
import { fileStorage } from './fileStorage';

const args = parseArgs(process.argv.slice(2), process.env);
if (!args.ok) {
  process.stderr.write(`dispatch tui: ${args.error}\n`);
  process.exit(2);
}

const client = createApiClient(`http://127.0.0.1:${args.port}`, args.token);
const storage = fileStorage(join(homedir(), '.config', 'dispatch', 'tui.json'));
// ctrl+c goes through the keymap like q, so both leave the terminal the same way.
const renderer = await createCliRenderer({ exitOnCtrlC: false });

const quit = () => {
  renderer.destroy();
  process.exit(0);
};

createRoot(renderer).render(
  <TuiRoot
    client={client}
    port={args.port}
    root={args.root}
    storage={storage}
    onQuit={quit}
  />
);
