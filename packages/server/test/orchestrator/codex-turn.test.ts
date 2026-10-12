import { CODEX_SIGNED_OUT_MESSAGE } from '@dispatch-foo/core';
import { describe, expect, it } from 'bun:test';

import {
  CODEX_STOPPED_MESSAGE,
  codexEffort,
  codexMcpConfig,
  runCodexTurn,
} from '../../src/orchestrator/codexTurn.js';
import type { CodexTurnRequest } from '../../src/orchestrator/codexTurn.js';
import type { CodexPermission } from '../../src/orchestrator/executors/codex.js';
import {
  FakeCodexProcess,
  finishTurn,
  scriptedCodex,
  waitFor,
} from './fakeCodex.js';

const PERMISSION: CodexPermission = {
  approvalPolicy: 'untrusted',
  approvalsReviewer: 'user',
  sandbox: 'workspace-write',
};

function request(
  codex: FakeCodexProcess,
  extra: Partial<CodexTurnRequest> = {}
): CodexTurnRequest {
  return {
    cwd: '/repo',
    prompt: 'hello',
    permission: PERMISSION,
    config: {},
    env: {},
    spawnProcess: () => codex,
    ...extra,
  };
}

const COMPLETED = { id: 'turn-1', status: 'completed', error: null };

describe('runCodexTurn', () => {
  it('handshakes, starts a thread and returns the final answer', async () => {
    const codex = scriptedCodex({ onTurn: (c, t) => finishTurn(c, t, 'done') });
    const result = await runCodexTurn(
      request(codex, {
        model: 'gpt-5.5',
        effort: 'high',
        developerInstructions: 'be brief',
        outputSchema: { type: 'object' },
      })
    );

    expect(result).toEqual({ threadId: 'thread-1', reply: 'done' });
    expect(
      codex.requests.filter((r) => r.method !== undefined).map((r) => r.method)
    ).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'thread/start',
      'turn/start',
    ]);
    expect(codex.paramsOf('initialize')?.capabilities).toBeNull();
    expect(codex.paramsOf('thread/start')).toEqual({
      model: 'gpt-5.5',
      cwd: '/repo',
      ...PERMISSION,
      config: {},
      developerInstructions: 'be brief',
    });
    expect(codex.paramsOf('turn/start')).toMatchObject({
      threadId: 'thread-1',
      effort: 'high',
      outputSchema: { type: 'object' },
    });
    expect(codex.killed).toBe(true);
  });

  it('declares the experimental API and dynamic tools on start, and resumes without them', async () => {
    const tools = [
      {
        type: 'function' as const,
        name: 'list_runs',
        description: 'Live and recent runs.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
    const first = scriptedCodex({ onTurn: (c, t) => finishTurn(c, t, 'one') });
    await runCodexTurn(
      request(first, { experimentalApi: true, dynamicTools: tools })
    );
    expect(first.paramsOf('initialize')?.capabilities).toEqual({
      experimentalApi: true,
      requestAttestation: false,
    });
    expect(first.paramsOf('thread/start')?.dynamicTools).toEqual(tools);

    const second = scriptedCodex({ onTurn: (c, t) => finishTurn(c, t, 'two') });
    const resumed = await runCodexTurn(
      request(second, {
        experimentalApi: true,
        dynamicTools: tools,
        resumeThreadId: 'thread-9',
      })
    );
    expect(resumed).toEqual({ threadId: 'thread-9', reply: 'two' });
    expect(second.paramsOf('thread/resume')).toMatchObject({
      threadId: 'thread-9',
    });
    expect(second.paramsOf('thread/resume')?.dynamicTools).toBeUndefined();
    expect(second.paramsOf('thread/start')).toBeUndefined();
  });

  it('fails with the plain signed-out message when Codex has no login', async () => {
    const codex = scriptedCodex({
      account: { account: null, requiresOpenaiAuth: true },
    });
    await expect(runCodexTurn(request(codex))).rejects.toThrow(
      CODEX_SIGNED_OUT_MESSAGE
    );
    expect(codex.paramsOf('thread/start')).toBeUndefined();
  });

  it('lets an API key stand in for a login, and lets an older Codex through', async () => {
    const keyed = scriptedCodex({
      account: { account: null, requiresOpenaiAuth: true },
      onTurn: (c, t) => finishTurn(c, t, 'keyed'),
    });
    const withKey = await runCodexTurn(
      request(keyed, { env: { OPENAI_API_KEY: 'sk-test' } })
    );
    expect(withKey.reply).toBe('keyed');

    const old = scriptedCodex({
      accountUnsupported: true,
      onTurn: (c, t) => finishTurn(c, t, 'old'),
    });
    expect((await runCodexTurn(request(old))).reply).toBe('old');
  });

  it('surfaces a missing codex binary as the spawn error explainFailure knows', async () => {
    const codex = new FakeCodexProcess();
    queueMicrotask(() => codex.failSpawn('spawn codex ENOENT'));
    await expect(runCodexTurn(request(codex))).rejects.toThrow(
      'spawn codex ENOENT'
    );
  });

  it('reports a process that dies mid-turn with its stderr', async () => {
    const codex = scriptedCodex({
      onTurn: (c) => c.exitWith(1, 'boom: model crashed'),
    });
    await expect(runCodexTurn(request(codex))).rejects.toThrow(
      'Codex App Server ended before the turn finished: process exited (code 1, signal null): boom: model crashed'
    );
  });

  it("throws a failed turn's own error message", async () => {
    const codex = scriptedCodex({
      onTurn: (c, t) =>
        c.notify('turn/completed', {
          threadId: t,
          turn: {
            id: 'turn-1',
            status: 'failed',
            error: { message: 'You have hit your usage limit.' },
          },
        }),
    });
    await expect(runCodexTurn(request(codex))).rejects.toThrow(
      'You have hit your usage limit.'
    );
  });

  it('prefers the final answer, ignores other threads, and reports usage', async () => {
    const codex = scriptedCodex({
      onTurn: (c, t) => {
        const item = (id: string, text: string, phase: string, threadId = t) =>
          c.notify('item/completed', {
            threadId,
            turnId: 'turn-1',
            item: { type: 'agentMessage', id, text, phase },
          });
        item('a', 'the answer', 'final_answer');
        item('b', 'one more note', 'commentary');
        item('c', 'not ours', 'final_answer', 'other-thread');
        c.notify('thread/tokenUsage/updated', {
          threadId: t,
          turnId: 'turn-1',
          tokenUsage: {
            total: {
              totalTokens: 1500,
              inputTokens: 1200,
              cachedInputTokens: 200,
              cacheWriteInputTokens: 0,
              outputTokens: 300,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 900,
              inputTokens: 800,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 100,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: null,
          },
        });
        c.notify('turn/completed', { threadId: t, turn: COMPLETED });
      },
    });
    const result = await runCodexTurn(request(codex));
    expect(result.reply).toBe('the answer');
    expect(result.total).toEqual({
      totalTokens: 1500,
      inputTokens: 1200,
      cachedInputTokens: 200,
      outputTokens: 300,
    });
    expect(result.contextTokens).toBe(800);
  });

  it('lets a hook steer the turn and fail it', async () => {
    const codex = scriptedCodex({
      onTurn: (c, t) =>
        setTimeout(
          () =>
            c.notify('item/started', {
              threadId: t,
              turnId: 'turn-1',
              item: {
                type: 'commandExecution',
                id: 'c1',
                command: 'ls',
                status: 'inProgress',
              },
            }),
          20
        ),
    });
    const seen: string[] = [];
    await expect(
      runCodexTurn(
        request(codex, {
          onItem: (item, completed, controls) => {
            seen.push(`${String(item.type)}:${String(completed)}`);
            controls.steer('look again');
            controls.fail('stopped by hook');
          },
        })
      )
    ).rejects.toThrow('stopped by hook');
    expect(seen).toEqual(['commandExecution:false']);
    await waitFor(() => codex.paramsOf('turn/steer') !== undefined);
    expect(codex.paramsOf('turn/steer')).toMatchObject({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'look again', text_elements: [] }],
    });
  });

  it('ends the turn on abort and kills the process', async () => {
    const controller = new AbortController();
    const codex = scriptedCodex({
      onTurn: () => queueMicrotask(() => controller.abort()),
    });
    await expect(
      runCodexTurn(request(codex, { signal: controller.signal }))
    ).rejects.toThrow(CODEX_STOPPED_MESSAGE);
    expect(codex.killed).toBe(true);
  });
});

describe('codexEffort', () => {
  it('maps max to xhigh and passes the rest through', () => {
    expect(codexEffort(undefined)).toBeUndefined();
    expect(codexEffort('low')).toBe('low');
    expect(codexEffort('xhigh')).toBe('xhigh');
    expect(codexEffort('max')).toBe('xhigh');
  });
});

describe('codexMcpConfig', () => {
  it('turns our servers on and every user server off', () => {
    expect(
      codexMcpConfig({ carto: { command: 'carto', args: ['mcp'], env: {} } }, [
        'stripe',
        'carto',
      ])
    ).toEqual({
      mcp_servers: {
        carto: { command: 'carto', args: ['mcp'], env: {}, required: true },
        stripe: { enabled: false },
      },
    });
  });
});
