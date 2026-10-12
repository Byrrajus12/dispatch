import { loadConfig } from '@dispatch-foo/core';

import type { SpawnCodexAppServer } from '../codexAppServer.js';
import { claimCodexToolCall } from '../codexDynamicTools.js';
import { codexEffort, codexMcpConfig, runCodexTurn } from '../codexTurn.js';
import {
  approvalResult,
  codexUserMcpServerNames,
  isCodexApprovalMethod,
} from '../executors/codex.js';
import type { CodexPermission } from '../executors/codex.js';
import type { Planner, PlannerMode, PlannerTurn } from '../planner.js';
import { plannerReadTools } from './codexReadTools.js';
import {
  CODEX_TURN_JSON_SCHEMA,
  EMPTY_TURN_MESSAGE,
  followupPrompt,
  openingPrompt,
  parseCodexTurnOutput,
} from './prompts.js';

// Never asks and cannot write. The read-only sandbox stays as a second layer
// under PLANNER_FEATURES, which takes the shell away entirely.
const PLANNER_PERMISSION: CodexPermission = {
  approvalPolicy: 'never',
  approvalsReviewer: 'user',
  sandbox: 'read-only',
};

// No shell (as ClaudePlanner has no Bash) and no sub-agents that could have one;
// the repo is read through plannerReadTools instead. apply_patch has no switch;
// Codex itself rejects it under read-only + never.
export const PLANNER_FEATURES = {
  shell_tool: false,
  unified_exec: false,
  multi_agent: false,
} as const;

// One planning attempt; a schema retry doubles it, so it stays under the runner's default.
const PLANNER_TURN_TIMEOUT_MS = 5 * 60_000;

// The retry's whole message: the thread already holds the request, so it is not resent.
const SCHEMA_RETRY_PROMPT =
  'Reply with only the JSON object matching the schema.';

interface CodexPlannerOptions {
  spawnProcess?: SpawnCodexAppServer;
  userMcpServers?: () => string[];
  env?: Record<string, string>;
}

// ClaudePlanner's conversation (same prompts, same turn shape) on Codex: one
// App Server turn per message in the main checkout; `sessionId` is the thread.
export class CodexPlanner implements Planner {
  // Each attempt in flight, so shutdown() can end its App Server.
  private readonly live = new Set<AbortController>();

  constructor(
    private readonly rootDir: string,
    private readonly options: CodexPlannerOptions = {}
  ) {}

  shutdown(): void {
    for (const abort of this.live) abort.abort();
  }

  start(
    prompt: string,
    model?: string,
    mode: PlannerMode = 'plan'
  ): Promise<PlannerTurn> {
    return this.runTurn(
      openingPrompt(mode, prompt),
      undefined,
      model,
      this.effortFor(mode)
    );
  }

  sendMessage(
    sessionId: string | undefined,
    message: string,
    model?: string,
    mode: PlannerMode = 'plan'
  ): Promise<PlannerTurn> {
    return this.runTurn(
      followupPrompt(mode, message),
      sessionId,
      model,
      this.effortFor(mode)
    );
  }

  // Config `effort.plan`, read per turn, for planning turns only (drafts send none).
  private effortFor(mode: PlannerMode): string | undefined {
    if (mode !== 'plan') return undefined;
    return codexEffort(loadConfig(this.rootDir).effort?.plan);
  }

  // One retry when the final message isn't the schema's JSON, as ClaudePlanner
  // retries: a short correction in the same thread, so nothing is sent or billed twice.
  private async runTurn(
    prompt: string,
    resume: string | undefined,
    model: string | undefined,
    effort: string | undefined
  ): Promise<PlannerTurn> {
    const first = await this.attemptTurn(prompt, resume, model, effort);
    if (first.turn !== null) return first.turn;
    const second = await this.attemptTurn(
      SCHEMA_RETRY_PROMPT,
      first.threadId,
      model,
      effort
    );
    if (second.turn !== null) return second.turn;
    throw new Error(EMPTY_TURN_MESSAGE);
  }

  private async attemptTurn(
    prompt: string,
    resume: string | undefined,
    model: string | undefined,
    effort: string | undefined
  ): Promise<{ turn: PlannerTurn | null; threadId: string }> {
    const userServers = (
      this.options.userMcpServers ?? codexUserMcpServerNames
    )();
    // Declared on thread/start; Codex keeps a thread's tools across resumes.
    const readTools = plannerReadTools(this.rootDir);
    const abort = new AbortController();
    this.live.add(abort);
    const result = await runCodexTurn({
      cwd: this.rootDir,
      prompt,
      resumeThreadId: resume,
      model,
      effort,
      permission: PLANNER_PERMISSION,
      config: {
        ...codexMcpConfig({}, userServers),
        features: PLANNER_FEATURES,
      },
      dynamicTools: readTools.tools,
      experimentalApi: true,
      signal: abort.signal,
      timeoutMs: PLANNER_TURN_TIMEOUT_MS,
      outputSchema: CODEX_TURN_JSON_SCHEMA,
      spawnProcess: this.options.spawnProcess,
      env: this.options.env,
      onServerRequest: (request, respond) => {
        if (claimCodexToolCall(readTools.handler, request, respond))
          return true;
        if (!isCodexApprovalMethod(request.method)) return false;
        respond(
          approvalResult(
            {
              method: request.method,
              params: request.params,
              providerRequestId: request.id,
            },
            { allow: false }
          )
        );
        return true;
      },
    }).finally(() => this.live.delete(abort));
    const output = parseCodexTurnOutput(result.reply);
    const threadId = result.threadId;
    if (output === null) return { turn: null, threadId };
    return {
      turn: {
        reply: output.message,
        proposal: output.proposal,
        questions: output.questions,
        sessionId: threadId,
      },
      threadId,
    };
  }
}
