import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { CodexAppServerProcess } from '../../src/orchestrator/codexAppServer.js';

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

// A stand-in `codex app-server` (same shape as codex-executor.test.ts's):
// records every line Dispatch writes and lets a test answer it.
export class FakeCodexProcess implements CodexAppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: RpcMessage[] = [];
  killed = false;
  private readonly events = new EventEmitter();
  private input = '';

  constructor(
    private readonly handleRequest: (
      request: RpcMessage,
      codex: FakeCodexProcess
    ) => void = () => {}
  ) {
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      this.input += chunk;
      for (;;) {
        const newline = this.input.indexOf('\n');
        if (newline === -1) return;
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        const request = JSON.parse(line) as RpcMessage;
        this.requests.push(request);
        if (request.method !== undefined) this.handleRequest(request, this);
      }
    });
  }

  once(
    event: 'error' | 'exit',
    listener:
      | ((error: Error) => void)
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
  ): this {
    this.events.once(event, listener);
    return this;
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.events.emit('exit', null, 'SIGTERM'));
    return true;
  }

  reply(id: number | string | undefined, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  replyError(id: number | string | undefined, message: string): void {
    this.stdout.write(
      `${JSON.stringify({ id, error: { code: -32601, message } })}\n`
    );
  }

  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  serverRequest(
    method: string,
    id: number | string,
    params: Record<string, unknown>
  ): void {
    this.stdout.write(`${JSON.stringify({ method, id, params })}\n`);
  }

  // Writes `stderr`, then exits with `code` once the write has landed.
  exitWith(code: number, stderr = ''): void {
    if (stderr !== '') this.stderr.write(stderr);
    setTimeout(() => this.events.emit('exit', code, null), 10);
  }

  failSpawn(message: string): void {
    this.events.emit('error', new Error(message));
  }

  paramsOf(method: string): Record<string, unknown> | undefined {
    return this.requests.find((r) => r.method === method)?.params;
  }

  responseTo(id: number | string): RpcMessage | undefined {
    return this.requests.find((r) => r.id === id && r.method === undefined);
  }
}

interface CodexScript {
  threadId?: string;
  /** What `account/read` answers; a signed-in ChatGPT account by default. */
  account?: unknown;
  /** Answer `account/read` with method-not-found, as a Codex older than it does. */
  accountUnsupported?: boolean;
  /** Runs right after `turn/start` is answered: emit the turn's items here. */
  onTurn?: (codex: FakeCodexProcess, threadId: string) => void;
}

// Answers the handshake, sign-in check, thread and turn requests the way
// codex-cli 0.160 does; a resume keeps the thread id it was asked for.
export function scriptedCodex(script: CodexScript = {}): FakeCodexProcess {
  return new FakeCodexProcess((request, codex) => {
    const asked = request.params?.threadId;
    const threadId =
      typeof asked === 'string' ? asked : (script.threadId ?? 'thread-1');
    if (request.method === 'initialize') codex.reply(request.id, {});
    else if (request.method === 'account/read') {
      if (script.accountUnsupported === true) {
        codex.replyError(request.id, 'Unsupported method: account/read');
      } else {
        codex.reply(
          request.id,
          script.account ?? {
            account: { type: 'chatgpt', email: null, planType: 'plus' },
            requiresOpenaiAuth: true,
          }
        );
      }
    } else if (
      request.method === 'thread/start' ||
      request.method === 'thread/resume'
    ) {
      codex.reply(request.id, { thread: { id: threadId } });
    } else if (request.method === 'turn/start') {
      codex.reply(request.id, { turn: { id: 'turn-1' } });
      script.onTurn?.(codex, threadId);
    } else if (request.method === 'turn/steer') {
      codex.reply(request.id, { turnId: 'turn-1' });
    }
  });
}

interface UsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

// Ends the scripted turn with `text` as Codex's final answer, after an
// optional token-usage report.
export function finishTurn(
  codex: FakeCodexProcess,
  threadId: string,
  text: string,
  extra: { usage?: { total: UsageBreakdown; last: UsageBreakdown } } = {}
): void {
  if (extra.usage !== undefined) {
    codex.notify('thread/tokenUsage/updated', {
      threadId,
      turnId: 'turn-1',
      tokenUsage: { ...extra.usage, modelContextWindow: null },
    });
  }
  codex.notify('item/completed', {
    threadId,
    turnId: 'turn-1',
    item: {
      type: 'agentMessage',
      id: 'msg-final',
      text,
      phase: 'final_answer',
    },
  });
  codex.notify('turn/completed', {
    threadId,
    turn: { id: 'turn-1', status: 'completed', error: null },
  });
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('timed out waiting for condition');
    await Bun.sleep(5);
  }
}
