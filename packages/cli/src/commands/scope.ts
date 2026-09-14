import type { Command } from 'commander';

import { createApiClient } from '../apiClient.js';
import type { CliContext } from '../context.js';
import { attachToRunningDaemon, resolveAppToken } from './appToken.js';

export function registerScopeCommands(program: Command, ctx: CliContext): void {
  const scope = program
    .command('scope')
    .description("Inspect and decide an agent's out-of-fence edit requests");

  scope
    .command('show <runId> <requestId>')
    .description('Show one scope request and whether it has been decided')
    .option('--json')
    .action(
      async (runId: string, requestId: string, opts: { json?: boolean }) => {
        const { baseUrl, agentToken } = await attachToRunningDaemon(ctx);
        const client = createApiClient(baseUrl, agentToken);
        const request = await client.getScopeRequest(runId, requestId);
        if (opts.json === true) {
          ctx.log(JSON.stringify(request, null, 2));
          return;
        }
        const state =
          request.granted === null
            ? 'pending'
            : request.granted
              ? 'granted'
              : 'denied';
        ctx.log(`${request.id}  run=${request.runId}  ${state}`);
        ctx.log(`paths: ${request.paths.join(', ')}`);
        ctx.log(`reason: ${request.reason}`);
        if (request.decisionReason !== null) {
          ctx.log(`decision: ${request.decisionReason}`);
        }
      }
    );

  scope
    .command('decide <runId> <requestId>')
    .description('Grant or deny a scope request (needs the daemon app token)')
    .option('--deny', 'deny the request instead of granting it')
    .option('--reason <text>', 'what to record as the justification')
    .option('--token <token>', 'the daemon app token (or DISPATCH_APP_TOKEN)')
    .action(
      async (
        runId: string,
        requestId: string,
        opts: { deny?: boolean; reason?: string; token?: string }
      ) => {
        const appToken = resolveAppToken(opts.token, 'dispatch scope decide');
        const { baseUrl } = await attachToRunningDaemon(ctx);
        const granted = opts.deny !== true;
        const reason =
          opts.reason ?? (granted ? 'granted at the CLI' : 'denied at the CLI');
        // A client of its own, built on the app token: nothing else this CLI
        // does gets to carry a decide-tier credential.
        const decided = await createApiClient(
          baseUrl,
          appToken
        ).decideScopeRequest(runId, requestId, granted, reason);
        ctx.log(
          `${decided.id} ${granted ? 'granted' : 'denied'} (${decided.paths.join(', ')})`
        );
      }
    );
}
