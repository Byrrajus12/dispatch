import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  claimCodexToolCall,
  codexDynamicTool,
} from '../../src/orchestrator/codexDynamicTools.js';
import type { CodexToolHandler } from '../../src/orchestrator/codexDynamicTools.js';

function toolCall(tool: string, args: unknown) {
  return {
    id: 'call-1',
    method: 'item/tool/call',
    params: {
      threadId: 't',
      turnId: 'u',
      callId: 'c1',
      namespace: null,
      tool,
      arguments: args,
    },
  };
}

// Claims `request` with `handler` and resolves with what was sent back to Codex.
function answer(
  handler: CodexToolHandler,
  request: { id: string; method: string; params?: unknown }
): Promise<{ claimed: boolean; result: Promise<unknown> }> {
  let respond!: (result: unknown) => void;
  const result = new Promise<unknown>((resolve) => {
    respond = resolve;
  });
  const claimed = claimCodexToolCall(handler, request, respond);
  return Promise.resolve({ claimed, result });
}

describe('codexDynamicTool', () => {
  it('declares a zod schema as plain JSON Schema', () => {
    const tool = codexDynamicTool(
      'read_file',
      'Reads a file.',
      z.object({ path: z.string(), limit: z.number().default(100) })
    );
    expect(tool).toMatchObject({
      type: 'function',
      name: 'read_file',
      description: 'Reads a file.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, limit: { type: 'number' } },
        required: ['path'],
      },
    });
    expect(tool.inputSchema.$schema).toBeUndefined();
  });

  it('describes a schema JSON Schema cannot hold loosely rather than failing', () => {
    const tool = codexDynamicTool(
      'odd',
      'Odd.',
      z.object({ when: z.date(), big: z.bigint() })
    );
    expect(tool.inputSchema.type).toBe('object');
  });
});

describe('claimCodexToolCall', () => {
  it('leaves requests that are not tool calls alone', async () => {
    const { claimed } = await answer(() => Promise.reject(new Error('no')), {
      id: 'a',
      method: 'item/commandExecution/requestApproval',
    });
    expect(claimed).toBe(false);
  });

  it('passes the call through and sends text content as is', async () => {
    const calls: [string, unknown][] = [];
    const { claimed, result } = await answer(
      (name, args) => {
        calls.push([name, args]);
        return Promise.resolve({ content: 'line 1\nline 2', isError: false });
      },
      toolCall('read_file', { path: 'a.ts' })
    );
    expect(claimed).toBe(true);
    expect(await result).toEqual({
      contentItems: [{ type: 'inputText', text: 'line 1\nline 2' }],
      success: true,
    });
    expect(calls).toEqual([['read_file', { path: 'a.ts' }]]);
  });

  it('sends structured content as JSON and a thrown handler as a failed call', async () => {
    const structured = await answer(
      () => Promise.resolve({ content: { error: 'nope' }, isError: true }),
      toolCall('x', {})
    );
    expect(await structured.result).toEqual({
      contentItems: [{ type: 'inputText', text: '{"error":"nope"}' }],
      success: false,
    });
    const thrown = await answer(
      () => Promise.reject(new Error('disk on fire')),
      toolCall('x', {})
    );
    expect(await thrown.result).toEqual({
      contentItems: [{ type: 'inputText', text: 'disk on fire' }],
      success: false,
    });
  });
});
