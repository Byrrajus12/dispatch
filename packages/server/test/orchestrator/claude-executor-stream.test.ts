import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';

import { ClaudeExecutor } from '../../src/orchestrator/executors/claude.js';
import {
  type ExecutorEvents,
  MAX_TOOL_RESULT_TEXT,
  type NormalizedEntry,
} from '../../src/orchestrator/types.js';
import { initGitRepo, withRunEndControls } from './helpers.js';

const repos: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

const RESULT = {
  type: 'result',
  subtype: 'success',
  session_id: 's-1',
  total_cost_usd: 0.01,
  num_turns: 1,
  is_error: false,
  result: '',
};

// Runs a ClaudeExecutor over a scripted SDK message stream and collects every
// entry it logs until the run finishes.
async function entriesFor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[]
): Promise<NormalizedEntry[]> {
  const repo = initGitRepo('dispatch-claude-stream-');
  repos.push(repo);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function* stream(): Generator<any> {
    yield { type: 'system', subtype: 'init', session_id: 's-1' };
    yield* messages;
    yield RESULT;
  }
  const executor = new ClaudeExecutor(() => withRunEndControls(stream()));
  const entries: NormalizedEntry[] = [];
  await new Promise<void>((resolve) => {
    const events: ExecutorEvents = {
      onEntry: (entry) => entries.push(entry),
      onApprovalRequest: () => {},
      onFinish: () => resolve(),
    };
    executor.start(
      { cwd: repo, prompt: 'go', permissionMode: 'acceptEdits' },
      events
    );
  });
  return entries;
}

function toolUse(id: string, name: string, parent: string | null = null) {
  return {
    type: 'assistant',
    session_id: 's-1',
    parent_tool_use_id: parent,
    message: {
      id: `msg-${id}`,
      content: [{ type: 'tool_use', id, name, input: { command: 'ls' } }],
    },
  };
}

function toolResult(
  id: string,
  content: unknown,
  opts: { isError?: boolean; parent?: string | null } = {}
) {
  return {
    type: 'user',
    session_id: 's-1',
    parent_tool_use_id: opts.parent ?? null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content,
          ...(opts.isError !== undefined ? { is_error: opts.isError } : {}),
        },
      ],
    },
  };
}

// A top-level tool_result is its call's outcome, logged as a `tool` entry of
// its own that readers fold into the call by toolUseId.
describe('ClaudeExecutor tool results', () => {
  it('logs a tool call, then its result with the same toolUseId and a preview', async () => {
    const entries = await entriesFor([
      toolUse('tu-1', 'Bash'),
      toolResult('tu-1', 'file-a\nfile-b'),
    ]);

    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'tool',
        toolName: 'Bash',
        toolUseId: 'tu-1',
        status: 'running',
      }),
      {
        ts: expect.any(String),
        kind: 'tool',
        toolUseId: 'tu-1',
        status: 'done',
        text: 'file-a\nfile-b',
      },
    ]);
  });

  it('marks a failed call as an error and reads text out of block content', async () => {
    const entries = await entriesFor([
      toolUse('tu-1', 'Bash'),
      toolResult(
        'tu-1',
        [
          { type: 'text', text: 'exit code 1' },
          { type: 'image', source: { type: 'base64', data: 'xx' } },
          { type: 'text', text: 'boom' },
        ],
        { isError: true }
      ),
    ]);

    expect(entries[1]).toMatchObject({
      kind: 'tool',
      toolUseId: 'tu-1',
      status: 'error',
      text: 'exit code 1\nboom',
    });
    expect(entries[1].toolName).toBeUndefined();
  });

  it('caps the preview and leaves out an empty one', async () => {
    const long = 'x'.repeat(MAX_TOOL_RESULT_TEXT + 50);
    const entries = await entriesFor([
      toolUse('tu-1', 'Read'),
      toolResult('tu-1', long),
      toolUse('tu-2', 'Write'),
      toolResult('tu-2', [{ type: 'image', source: {} }]),
    ]);

    expect(entries[1].text).toBe(
      `${'x'.repeat(MAX_TOOL_RESULT_TEXT)}… (truncated)`
    );
    expect(entries[3]).toMatchObject({ toolUseId: 'tu-2', status: 'done' });
    expect('text' in entries[3]).toBe(false);
  });

  it("skips a sub-agent's results, unknown calls and repeats", async () => {
    const entries = await entriesFor([
      toolUse('tu-sub', 'Grep', 'tu-spawn'),
      toolResult('tu-sub', 'match', { parent: 'tu-spawn' }),
      toolResult('tu-never-called', 'stray'),
      toolUse('tu-1', 'Bash'),
      toolResult('tu-1', 'once'),
      toolResult('tu-1', 'twice'),
    ]);

    expect(
      entries.map((e) => [e.toolUseId, e.status, e.parentToolUseId ?? null])
    ).toEqual([
      ['tu-sub', 'running', 'tu-spawn'],
      ['tu-1', 'running', null],
      ['tu-1', 'done', null],
    ]);
  });
});
