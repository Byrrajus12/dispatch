import { z } from 'zod';

import type { CodexAppServerRequest } from './codexAppServer.js';
import type { CodexDynamicTool } from './codexTurn.js';
import { objectValue } from './executors/codex.js';

/** What one Dispatch-served tool call hands back to Codex. */
interface CodexToolOutcome {
  /** A string goes to the model as is; anything else as JSON. */
  content: unknown;
  isError: boolean;
}

/** Runs one call Codex made to a dynamic tool Dispatch declared. */
export type CodexToolHandler = (
  name: string,
  args: unknown
) => Promise<CodexToolOutcome>;

// The zod schema as JSON Schema minus `$schema`; one that can't convert takes no
// arguments, since the handler re-parses every call anyway.
function jsonSchemaOf(schema: z.ZodType<unknown>): Record<string, unknown> {
  try {
    const converted = {
      ...(z.toJSONSchema(schema, {
        io: 'input',
        unrepresentable: 'any',
      }) as Record<string, unknown>),
    };
    delete converted.$schema;
    return converted;
  } catch {
    return { type: 'object', properties: {} };
  }
}

/** One tool as Codex's `dynamicTools` declares it, from its zod input schema. */
export function codexDynamicTool(
  name: string,
  description: string,
  inputSchema: z.ZodType<unknown>
): CodexDynamicTool {
  return {
    type: 'function',
    name,
    description,
    inputSchema: jsonSchemaOf(inputSchema),
  };
}

function toolText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

// Runs one `item/tool/call` through `handler` and answers in Codex's shape; a
// thrown handler is a failed call the model reads, not a failed turn.
async function answerToolCall(
  handler: CodexToolHandler,
  request: CodexAppServerRequest,
  respond: (result: unknown) => void
): Promise<void> {
  const params = objectValue(request.params);
  const name = typeof params?.tool === 'string' ? params.tool : '';
  let outcome: CodexToolOutcome;
  try {
    outcome = await handler(name, params?.arguments ?? {});
  } catch (error) {
    outcome = {
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
  respond({
    contentItems: [{ type: 'inputText', text: toolText(outcome.content) }],
    success: !outcome.isError,
  });
}

/**
 * Claims Codex's dynamic-tool calls for `runCodexTurn`'s `onServerRequest`:
 * true (and answered via `handler`) for `item/tool/call`, false for anything else.
 */
export function claimCodexToolCall(
  handler: CodexToolHandler,
  request: CodexAppServerRequest,
  respond: (result: unknown) => void
): boolean {
  if (request.method !== 'item/tool/call') return false;
  void answerToolCall(handler, request, respond);
  return true;
}
