import {
  agentEnv,
  CODEX_SIGNED_OUT_MESSAGE,
  CORE_VERSION,
} from '@dispatch-foo/core';
import type { EffortLevel } from '@dispatch-foo/core';

import { CodexAppServer } from './codexAppServer.js';
import type {
  CodexAppServerRequest,
  SpawnCodexAppServer,
} from './codexAppServer.js';
import type { StdioServerSpec } from './dispatchMcp.js';
import {
  closeDescription,
  objectValue,
  textInput,
  toCodexMcp,
  tokenTotal,
} from './executors/codex.js';
import type {
  CodexItem,
  CodexPermission,
  CodexTokenTotal,
} from './executors/codex.js';

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;

/** Why a Codex planner or Overseer turn ended when Stop was pressed. */
export const CODEX_STOPPED_MESSAGE = 'the Codex turn was stopped';

/** One client-side tool Codex can call back into Dispatch for (`item/tool/call`). */
export interface CodexDynamicTool {
  type: 'function';
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What a hook can do to the turn it is watching. */
export interface CodexTurnControls {
  /** Ends the turn now, with `message` as its error. */
  fail(message: string): void;
  /** Adds text to the running turn, as a mid-turn human message would. */
  steer(text: string): void;
}

export interface CodexTurnRequest {
  cwd: string;
  prompt: string;
  /** The thread to resume; absent starts a fresh one. */
  resumeThreadId?: string;
  model?: string;
  effort?: string;
  permission: CodexPermission;
  /** Codex `config` overrides for the thread, e.g. `mcp_servers`. */
  config: Record<string, unknown>;
  developerInstructions?: string;
  /** Sent on thread/start only; Codex keeps them with the thread. */
  dynamicTools?: CodexDynamicTool[];
  /** JSON Schema the turn's final message must match. */
  outputSchema?: Record<string, unknown>;
  /** Opts into Codex's experimental API, which dynamic tools need. */
  experimentalApi?: boolean;
  signal?: AbortSignal;
  /** Ends the turn with an error after this long; 10 minutes by default. */
  timeoutMs?: number;
  spawnProcess?: SpawnCodexAppServer;
  /** The env the sign-in check reads for an API key; agentEnv() by default. */
  env?: Record<string, string>;
  /** Claims a server request (an approval, a tool call) by returning true; answer via `respond`. */
  onServerRequest?: (
    request: CodexAppServerRequest,
    respond: (result: unknown) => void,
    controls: CodexTurnControls
  ) => boolean;
  onItem?: (
    item: CodexItem,
    completed: boolean,
    controls: CodexTurnControls
  ) => void;
  onTerminalInput?: (
    itemId: string,
    stdin: string,
    controls: CodexTurnControls
  ) => void;
}

interface CodexTurnResult {
  threadId: string;
  /** The turn's final answer; '' when Codex said nothing. */
  reply: string;
  /** Cumulative thread token totals, when Codex reported them. */
  total?: CodexTokenTotal;
  /** Input tokens of the turn's last model call: how full the context is. */
  contextTokens?: number;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function describeMinutes(ms: number): string {
  const minutes = ms / 60_000;
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

// Dispatch effort to Codex effort: Codex has no `max`, so it gets `xhigh`.
export function codexEffort(
  effort: EffortLevel | undefined
): string | undefined {
  if (effort === undefined) return undefined;
  return effort === 'max' ? 'xhigh' : effort;
}

// The `mcp_servers` table for a planner or Overseer thread: ours on, every
// server from the user's own Codex config off (Codex starts all of them otherwise).
export function codexMcpConfig(
  ours: Record<string, StdioServerSpec>,
  userServers: readonly string[]
): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(ours)) {
    servers[name] = toCodexMcp(spec);
  }
  for (const name of userServers) {
    if (!(name in servers)) servers[name] = { enabled: false };
  }
  return { mcp_servers: servers };
}

// Throws the plain signed-out message when Codex has no login and no API key.
// A Codex too old for account/read is let through; its turn reports auth itself.
async function assertSignedIn(
  server: CodexAppServer,
  env: Record<string, string>
): Promise<void> {
  let status: { account?: unknown; requiresOpenaiAuth?: unknown };
  try {
    status = await server.request<{
      account?: unknown;
      requiresOpenaiAuth?: unknown;
    }>('account/read', { refreshToken: false });
  } catch {
    return;
  }
  const hasKey =
    (env.OPENAI_API_KEY ?? '') !== '' || (env.CODEX_API_KEY ?? '') !== '';
  if (
    status.account === null &&
    status.requiresOpenaiAuth === true &&
    !hasKey
  ) {
    throw new Error(CODEX_SIGNED_OUT_MESSAGE);
  }
}

// One Codex turn in its own App Server process, closed afterwards. Shared by
// the planner and the Overseer; the executor keeps its own streaming loop.
export async function runCodexTurn(
  req: CodexTurnRequest
): Promise<CodexTurnResult> {
  const server = new CodexAppServer(req.cwd, req.spawnProcess);
  let threadId: string | undefined;
  let turnId: string | undefined;
  let reply = '';
  let replyIsFinal = false;
  let total: CodexTokenTotal | undefined;
  let contextTokens: number | undefined;
  let failure: Error | undefined;
  let settled = false;
  const queuedSteers: string[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const end = (error?: Error): void => {
    if (settled) return;
    settled = true;
    failure = error;
    resolveDone();
  };
  const sendSteer = (text: string): void => {
    if (threadId === undefined || turnId === undefined) return;
    try {
      void server
        .request('turn/steer', {
          threadId,
          expectedTurnId: turnId,
          input: textInput(text),
        })
        .catch(() => undefined);
    } catch {
      // The process is gone; the turn's own end reports why.
    }
  };
  const controls: CodexTurnControls = {
    fail: (message) => end(new Error(message)),
    steer: (text) => {
      if (settled) return;
      if (turnId === undefined) queuedSteers.push(text);
      else sendSteer(text);
    },
  };

  server.onServerRequest((request) => {
    if (settled || req.onServerRequest === undefined) return false;
    try {
      return req.onServerRequest(
        request,
        (result) => {
          if (settled) return;
          try {
            server.respond(request.id, result);
          } catch {
            // The process is gone; the turn's own end reports why.
          }
        },
        controls
      );
    } catch (error) {
      end(toError(error));
      return true;
    }
  });

  server.onMessage((message) => {
    if (settled || message.id !== undefined) return;
    const params = objectValue(message.params);
    if (
      threadId !== undefined &&
      params?.threadId !== undefined &&
      params.threadId !== threadId
    ) {
      return;
    }
    if (
      message.method === 'item/started' ||
      message.method === 'item/completed'
    ) {
      const item = objectValue(params?.item) as CodexItem | undefined;
      if (item === undefined) return;
      const completed = message.method === 'item/completed';
      if (
        completed &&
        item.type === 'agentMessage' &&
        typeof item.text === 'string'
      ) {
        const isFinal = item.phase === 'final_answer';
        if (isFinal || !replyIsFinal) {
          reply = item.text;
          replyIsFinal = isFinal;
        }
      }
      try {
        req.onItem?.(item, completed, controls);
      } catch (error) {
        end(toError(error));
      }
      return;
    }
    if (message.method === 'item/commandExecution/terminalInteraction') {
      if (
        typeof params?.itemId === 'string' &&
        typeof params.stdin === 'string'
      ) {
        try {
          req.onTerminalInput?.(params.itemId, params.stdin, controls);
        } catch (error) {
          end(toError(error));
        }
      }
      return;
    }
    if (message.method === 'thread/tokenUsage/updated') {
      const usage = objectValue(params?.tokenUsage);
      total = tokenTotal(usage?.total) ?? total;
      contextTokens = tokenTotal(usage?.last)?.inputTokens ?? contextTokens;
      return;
    }
    if (message.method !== 'turn/completed') return;
    const turn = objectValue(params?.turn);
    if (turnId !== undefined && turn?.id !== turnId) return;
    if (turn?.status === 'completed') {
      end();
      return;
    }
    const turnError = objectValue(turn?.error)?.message;
    end(
      new Error(
        typeof turnError === 'string'
          ? turnError
          : `Codex turn ended with status ${String(turn?.status)}`
      )
    );
  });

  void server.closed.then((close) =>
    end(
      new Error(
        `Codex App Server ended before the turn finished: ${closeDescription(close)}`
      )
    )
  );

  const onAbort = (): void => end(new Error(CODEX_STOPPED_MESSAGE));
  req.signal?.addEventListener('abort', onAbort, { once: true });
  if (req.signal?.aborted === true) onAbort();

  const drive = async (): Promise<void> => {
    await server.request('initialize', {
      clientInfo: {
        name: 'dispatch',
        title: 'Dispatch',
        version: CORE_VERSION,
      },
      capabilities:
        req.experimentalApi === true
          ? { experimentalApi: true, requestAttestation: false }
          : null,
    });
    server.notify('initialized');
    await assertSignedIn(server, req.env ?? agentEnv());
    const thread = {
      model: req.model,
      cwd: req.cwd,
      ...req.permission,
      config: req.config,
      ...(req.developerInstructions === undefined
        ? {}
        : { developerInstructions: req.developerInstructions }),
    };
    const resumed = req.resumeThreadId !== undefined;
    const response = await server.request<{ thread?: { id?: unknown } }>(
      resumed ? 'thread/resume' : 'thread/start',
      resumed
        ? { threadId: req.resumeThreadId, ...thread }
        : {
            ...thread,
            ...(req.dynamicTools === undefined
              ? {}
              : { dynamicTools: req.dynamicTools }),
          }
    );
    const id = response.thread?.id;
    if (typeof id !== 'string' || id === '') {
      throw new Error('Codex App Server returned no thread.id');
    }
    if (resumed && id !== req.resumeThreadId) {
      throw new Error(
        `Codex resume returned thread ${id} instead of ${String(req.resumeThreadId)}`
      );
    }
    threadId = id;
    const turn = await server.request<{ turn?: { id?: unknown } }>(
      'turn/start',
      {
        threadId: id,
        input: textInput(req.prompt),
        ...(req.effort === undefined ? {} : { effort: req.effort }),
        ...(req.outputSchema === undefined
          ? {}
          : { outputSchema: req.outputSchema }),
      }
    );
    if (typeof turn.turn?.id === 'string') turnId = turn.turn.id;
    for (const text of queuedSteers.splice(0)) sendSteer(text);
  };
  void drive().catch((error: unknown) => end(toError(error)));

  const timeoutMs = req.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const timer = setTimeout(
    () =>
      end(
        new Error(`Codex didn't finish within ${describeMinutes(timeoutMs)}.`)
      ),
    timeoutMs
  );
  await done;
  clearTimeout(timer);
  req.signal?.removeEventListener('abort', onAbort);
  server.close();
  if (failure !== undefined) throw failure;
  if (threadId === undefined) {
    throw new Error('Codex App Server returned no thread.id');
  }
  return {
    threadId,
    reply,
    ...(total === undefined ? {} : { total }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
  };
}
