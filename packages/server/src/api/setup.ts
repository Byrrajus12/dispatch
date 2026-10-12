import {
  defaultSetupCheckDeps,
  providerById,
  runSetupCheck,
  type SetupCheckDeps,
  writeAgentKey,
} from '@dispatch-foo/core';

import type { ApiContext } from '../api.js';
import { refreshExecutors } from '../index.js';
import { errorResponse, jsonResponse, readJsonBody } from './http.js';

// The routes under /api/setup: what this machine still needs before an agent can
// run, saving an agent API key, and picking up agents installed since boot.

type SetupRouteContext = Pick<
  ApiContext,
  'rootDir' | 'orchestrator' | 'planManager' | 'overseerManager'
>;

let depsFactory: () => SetupCheckDeps = defaultSetupCheckDeps;

/** Tests swap in scripted probes; null restores the real ones. */
export function setSetupCheckDepsForTest(
  factory: (() => SetupCheckDeps) | null
): void {
  depsFactory = factory ?? defaultSetupCheckDeps;
}

async function report(ctx: SetupRouteContext): Promise<Response> {
  return jsonResponse(
    await runSetupCheck(
      {
        rootDir: ctx.rootDir,
        defaultExecutor: ctx.orchestrator.defaultExecutorName(),
      },
      depsFactory()
    )
  );
}

export async function handleSetupRoute(
  req: Request,
  method: string,
  segments: readonly string[],
  ctx: SetupRouteContext
): Promise<Response | null> {
  if (segments.length === 1 && method === 'GET') return report(ctx);

  if (
    segments.length === 2 &&
    segments[1] === 'agent-key' &&
    method === 'POST'
  ) {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value as { provider?: unknown; apiKey?: unknown };
    const spec =
      typeof body.provider === 'string'
        ? providerById(body.provider)
        : undefined;
    if (spec?.apiKeyEnv === undefined)
      return errorResponse(400, 'provider takes no API key');
    if (body.apiKey !== null && typeof body.apiKey !== 'string')
      return errorResponse(400, 'apiKey must be a string or null');
    writeAgentKey(spec.apiKeyEnv, body.apiKey);
    return report(ctx);
  }

  if (segments.length === 2 && segments[1] === 'refresh' && method === 'POST') {
    return jsonResponse({
      added: refreshExecutors(ctx.orchestrator, ctx.rootDir, ctx),
    });
  }
  return null;
}
