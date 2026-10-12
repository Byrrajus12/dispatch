import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { agentEnv, loadConfig } from '@dispatch-foo/core';
import type { EffortLevel } from '@dispatch-foo/core';

import { openClaudeQuery, rewriteMissingCliError } from '../claudeCli.js';
import { floorGuard } from '../floorHook.js';
import type { Planner, PlannerMode, PlannerTurn } from '../planner.js';
import {
  EMPTY_TURN_MESSAGE,
  followupPrompt,
  openingPrompt,
  TURN_JSON_SCHEMA,
} from './prompts.js';
import type { PlannerTurnOutput } from './prompts.js';

// Both `tools` and `allowedTools` set to the same list: the former restricts
// which tools the model sees, the latter pre-approves them. No Bash: plan mode
// does not stop a shell command from writing, and against the bundled CLI a
// pre-approved Bash wrote one file and deleted another in the checkout.
// Reading and searching are all a plan needs.
const PLANNER_TOOLS = ['Read', 'Grep', 'Glob'];

/**
 * The real planner backend: a read-only Agent SDK planning *conversation* in
 * the main checkout (no worktree — a plan proposes work, it never touches the
 * repo), with only the reading and searching tools in PLANNER_TOOLS, and a
 * json_schema `outputFormat` so each turn arrives as structured data instead
 * of free text to parse. Every turn is a discrete `query()` call: the opening
 * turn starts a fresh session; each follow-up passes the prior turn's
 * `session_id` as `resume` so the model retains full context across turns
 * without keeping a process alive between them. CI never constructs this — see
 * FakePlanner.
 */
export class ClaudePlanner implements Planner {
  // Defaults to the real SDK's `query()`; tests can inject a stub that yields a
  // scripted SDKMessage stream instead, mirroring ClaudeExecutor's own
  // `queryFn` seam.
  constructor(
    private readonly rootDir: string,
    private readonly queryFn: typeof query = query
  ) {}

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

  // Config `effort.plan`, read per turn so a settings change applies on the
  // next one. Planning turns only: a draft runs on the cheap `draft` model.
  private effortFor(mode: PlannerMode): EffortLevel | undefined {
    if (mode !== 'plan') return undefined;
    return loadConfig(this.rootDir).effort?.plan;
  }

  // Runs one turn, retrying attemptTurn once if the first call returns null.
  private async runTurn(
    prompt: string,
    resume: string | undefined,
    model: string | undefined,
    effort: EffortLevel | undefined
  ): Promise<PlannerTurn> {
    const first = await this.attemptTurn(prompt, resume, model, effort);
    if (first !== null) return first;
    const second = await this.attemptTurn(prompt, resume, model, effort);
    if (second !== null) return second;
    throw new Error(EMPTY_TURN_MESSAGE);
  }

  // One attempt at a turn; returns null (not a throw) when the result has no
  // structured output — see runTurn.
  private async attemptTurn(
    prompt: string,
    resume: string | undefined,
    model: string | undefined,
    effort: EffortLevel | undefined
  ): Promise<PlannerTurn | null> {
    const options: Options = {
      cwd: this.rootDir,
      permissionMode: 'plan',
      env: agentEnv(),
      outputFormat: { type: 'json_schema', schema: TURN_JSON_SCHEMA },
      // `'project'` loads CLAUDE.md/AGENTS.md; `'user'` omitted to isolate from
      // operator's personal environment.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project', 'local'],
      tools: PLANNER_TOOLS,
      allowedTools: PLANNER_TOOLS,
      // The planner has no shell, but it has no human on hand to approve
      // anything either, so an irreversible command that reached it some
      // other way is refused (see floorGuard).
      ...floorGuard('deny'),
      strictMcpConfig: true,
      skills: [],
      ...(resume !== undefined ? { resume } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    };
    // Same CLI-resolution chain (DISPATCH_CLAUDE_BIN -> bundled SDK CLI ->
    // PATH `claude` -> install hint) ClaudeExecutor.openQuery uses — see
    // claudeCli.ts. Without this, a packaged app (no node_modules bundled
    // CLI) surfaced the SDK's raw "Native CLI binary for ... not found"
    // message straight through PlanManager's `plan.changed` broadcast as
    // "planning failed: Native CLI binary ...", even though dispatching a
    // run from the task page already worked (that path goes through
    // ClaudeExecutor, which had this fallback chain and the earlier
    // packaged-desktop-app fix did not extend it here).
    const sdkQuery: Query = openClaudeQuery(this.queryFn, prompt, options);

    try {
      let sessionId: string | undefined;
      for await (const message of sdkQuery) {
        if (message.type === 'system') {
          sessionId = message.session_id;
          continue;
        }
        if (message.type !== 'result') continue;
        if (message.subtype !== 'success') {
          throw new Error(
            `planner failed: ${message.subtype}${
              'errors' in message && message.errors.length > 0
                ? ` — ${message.errors.join('; ')}`
                : ''
            }`
          );
        }
        if (message.structured_output === undefined) return null;
        const output = message.structured_output as PlannerTurnOutput;
        return {
          reply: output.message,
          proposal: output.proposal,
          questions: output.questions,
          sessionId: message.session_id ?? sessionId,
        };
      }
      throw new Error('planner produced no result message');
    } catch (err) {
      // The missing-CLI error can also surface lazily on the first
      // iteration (rather than synchronously from openClaudeQuery above) —
      // apply the same install-hint rewrite here too, mirroring
      // ClaudeExecutor's consume() catch block. Any other error (validation
      // failure, no-result, ...) passes through unchanged.
      throw new Error(rewriteMissingCliError((err as Error).message));
    }
  }
}
