import { DEFAULT_EXECUTOR_NAME, executorModels } from '@dispatch-foo/core';
import type { DispatchConfig, ExecutorModels } from '@dispatch-foo/core';

// Backends that run a non-Claude model family; every other name keeps the Claude roles.
const NON_CLAUDE_BACKENDS: ReadonlySet<string> = new Set(['codex']);

// Claude Code's model aliases, besides the `claude-*` ids.
const CLAUDE_ALIASES: ReadonlySet<string> = new Set([
  'opus',
  'sonnet',
  'haiku',
  'fable',
]);

/** Whether `model` names a Claude model, which only the Claude backend can run. */
export function isClaudeModelId(model: string): boolean {
  return model.startsWith('claude-') || CLAUDE_ALIASES.has(model);
}

/** The planner or overseer backend for a caller that names none: the default agent's, else Claude's, else Codex's. */
export function pickAgentBackend(
  registered: readonly string[],
  preferred: string
): string {
  for (const name of [preferred, DEFAULT_EXECUTOR_NAME, 'codex']) {
    if (registered.includes(name)) return name;
  }
  return registered[0] ?? DEFAULT_EXECUTOR_NAME;
}

// The model a turn runs on: the caller's pick, else the Claude role, except that
// Codex never gets a Claude id and falls back to `executors.codex.models.<role>`.
export function backendModel(
  config: Pick<DispatchConfig, 'models' | 'executors'>,
  backendName: string,
  role: keyof ExecutorModels,
  claudeModel: string,
  chosen?: string
): string | undefined {
  if (!NON_CLAUDE_BACKENDS.has(backendName)) return chosen ?? claudeModel;
  if (chosen !== undefined && !isClaudeModelId(chosen)) return chosen;
  return executorModels(config, backendName)[role];
}
