import type { ExecutorPricing } from '@dispatch-foo/core';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, relative, resolve } from 'node:path';

import { floorCheckForCommand, floorCheckForToolInput } from '../../floor.js';
import type { SpawnCodexAppServer } from '../codexAppServer.js';
import { claimCodexToolCall, codexDynamicTool } from '../codexDynamicTools.js';
import { codexEffort, codexMcpConfig, runCodexTurn } from '../codexTurn.js';
import type { CodexDynamicTool, CodexTurnControls } from '../codexTurn.js';
import { cartoMcpSpec } from '../dispatchMcp.js';
import type { StdioServerSpec } from '../dispatchMcp.js';
import {
  approvalResult,
  CODEX_APPROVAL_TOOL_NAMES,
  codexCostUsd,
  codexPermission,
  codexPricingFor,
  codexUserMcpServerNames,
  fileChangePaths,
  isCodexApprovalMethod,
  objectValue,
} from '../executors/codex.js';
import type {
  CodexItem,
  CodexPermission,
  PendingCodexApproval,
} from '../executors/codex.js';
import { toolDescriptionForModel } from '../overseerBackend.js';
import type {
  OverseerBackend,
  OverseerToolDescriptor,
  OverseerToolset,
  OverseerTurn,
  OverseerTurnOptions,
} from '../overseerBackend.js';
import { overseerHoldFor } from '../overseerHold.js';
import type { OverseerHold } from '../overseerHold.js';
import {
  EMPTY_REPLY_MESSAGE,
  overseerInstructions,
} from '../overseerPrompt.js';
import type { ApprovalDecision } from '../types.js';

const INSTRUCTIONS = overseerInstructions('Codex');

// Asks Dispatch about every non-read-only command; where a mode Codex can't honour lands.
const ASK_EVERY_COMMAND: CodexPermission = {
  approvalPolicy: 'untrusted',
  approvalsReviewer: 'user',
  sandbox: 'workspace-write',
};

/** The Codex settings an Overseer turn runs under: a human is on hand, so unmapped modes ask. */
export function overseerPermission(mode: string | undefined): CodexPermission {
  return codexPermission(mode ?? 'default') ?? ASK_EVERY_COMMAND;
}

function dynamicTool(descriptor: OverseerToolDescriptor): CodexDynamicTool {
  return codexDynamicTool(
    descriptor.name,
    toolDescriptionForModel(descriptor),
    descriptor.inputSchema
  );
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const SHELL_FLAG = /^--?[A-Za-z][A-Za-z-]*$/;
const COMMAND_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;
const SHELL_OPERATOR = /[;&|<>()`$\n]/;
const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

// A command line split into words, or undefined when it holds anything beyond
// plain and quoted words (an operator, a substitution, an unclosed quote).
function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  let i = 0;
  while (i < command.length) {
    const char = command[i];
    if (char === ' ' || char === '\t') {
      if (word !== undefined) words.push(word);
      word = undefined;
      i += 1;
    } else if (char === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return undefined;
      word = (word ?? '') + command.slice(i + 1, close);
      i = close + 1;
    } else if (char === '"') {
      let text = '';
      i += 1;
      while (i < command.length && command[i] !== '"') {
        if (/[$`]/.test(command[i])) return undefined;
        if (command[i] === '\\' && /["\\]/.test(command[i + 1] ?? '')) i += 1;
        text += command[i];
        i += 1;
      }
      if (i >= command.length) return undefined;
      word = (word ?? '') + text;
      i += 1;
    } else if (char === '\\') {
      if (i + 1 >= command.length) return undefined;
      word = (word ?? '') + command[i + 1];
      i += 2;
    } else if (SHELL_OPERATOR.test(char)) {
      return undefined;
    } else {
      word = (word ?? '') + char;
      i += 1;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

// The script of `<shell> [-flags] -c '<script>'`, the form Codex runs nearly every command in.
function shellScript(words: readonly string[]): string | undefined {
  if (words.length < 3 || !SHELLS.has(basename(words[0]))) return undefined;
  const flags = words.slice(1, -1);
  return flags.every((flag) => SHELL_FLAG.test(flag)) &&
    flags.some((flag) => COMMAND_FLAG.test(flag))
    ? words.at(-1)
    : undefined;
}

function quoted(word: string): string {
  return PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * A Codex command as the one string holds, floor checks and grants read: a
 * shell wrapper (string or argv) unwrapped to its script, an argv joined.
 * Undefined when there is no command to read, which callers treat as unknown.
 */
function commandText(command: unknown): string | undefined {
  let current: string | undefined;
  if (typeof command === 'string') current = command;
  else if (
    Array.isArray(command) &&
    command.length > 0 &&
    command.every((word) => typeof word === 'string')
  ) {
    current = shellScript(command) ?? command.map(quoted).join(' ');
  }
  // Unwrap nested wrappers (`bash -lc "sh -c '…'"`) a few levels deep.
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    const words = shellWords(current);
    const script = words === undefined ? undefined : shellScript(words);
    if (script === undefined) break;
    current = script;
  }
  return current === undefined || current.trim() === '' ? undefined : current;
}

/** What an approval shows the human and what the floor and hold checks read. */
interface ApprovalView {
  input: Record<string, unknown>;
  /** False when the ask names no command or no edited path: it must reach a human. */
  known: boolean;
}

function approvalView(
  approval: PendingCodexApproval,
  editPaths: ReadonlyMap<string, string[]>
): ApprovalView {
  const params = objectValue(approval.params) ?? {};
  const reason =
    typeof params.reason === 'string' ? { reason: params.reason } : {};
  if (approval.method === 'item/commandExecution/requestApproval') {
    const command = commandText(params.command);
    return {
      input: {
        command: command ?? params.command ?? null,
        cwd: params.cwd,
        ...reason,
      },
      known: command !== undefined,
    };
  }
  if (approval.method === 'item/fileChange/requestApproval') {
    const itemId = typeof params.itemId === 'string' ? params.itemId : '';
    const paths = editPaths.get(itemId) ?? [];
    return {
      input: {
        paths,
        ...(typeof params.grantRoot === 'string'
          ? { grantRoot: params.grantRoot }
          : {}),
        ...reason,
      },
      known: paths.length > 0,
    };
  }
  return { input: { permissions: params.permissions, ...reason }, known: true };
}

// The Overseer hold an ask needs. An edit with no paths Codex announced is held
// as a `.dispatch` write, since nothing shows it is not one.
function holdFor(
  toolName: string,
  view: ApprovalView,
  rootDir: string
): OverseerHold | null {
  if (toolName !== 'codex.fileChange') {
    return overseerHoldFor(toolName, view.input, rootDir);
  }
  if (!view.known) return 'dispatch-files';
  const grantRoot = view.input.grantRoot;
  const paths = [
    ...(view.input.paths as string[]),
    ...(typeof grantRoot === 'string' ? [grantRoot] : []),
  ];
  return overseerHoldFor(toolName, { paths }, rootDir);
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, resolve(root, path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// Answers the Overseer gives without asking, only for a readable ask with no hold:
// bypass allows it, acceptEdits allows an edit inside the checkout; undefined means ask.
function selfDecision(
  mode: string | undefined,
  approval: PendingCodexApproval,
  view: ApprovalView,
  held: boolean,
  rootDir: string
): ApprovalDecision | undefined {
  if (held || !view.known) return undefined;
  if (mode === 'bypassPermissions') return { allow: true };
  if (
    mode === 'acceptEdits' &&
    approval.method === 'item/fileChange/requestApproval' &&
    view.input.grantRoot === undefined
  ) {
    const paths = view.input.paths as string[];
    return paths.every((path) => isInside(rootDir, path))
      ? { allow: true }
      : undefined;
  }
  return undefined;
}

// A floor command Codex ran without asking Dispatch (an allow rule in $CODEX_HOME/rules).
function unaskedFloorCommand(
  item: CodexItem,
  flooredAsks: ReadonlySet<string>
): string | undefined {
  if (
    item.type !== 'commandExecution' ||
    item.status !== 'completed' ||
    typeof item.id !== 'string' ||
    flooredAsks.has(`command:${item.id}`)
  ) {
    return undefined;
  }
  const command = commandText(item.command);
  const check = command === undefined ? null : floorCheckForCommand(command);
  if (check === null) return undefined;
  return `Codex ran a floor command (${check}) without asking Dispatch, most likely under an allow rule in $CODEX_HOME/rules: ${command ?? ''}. The Overseer turn is stopped so you can review it.`;
}

// One turn's approval bookkeeping: edit paths Codex announced, asks that
// carried a floor command, and the unfinished line typed into each shell.
class ApprovalGate {
  private readonly editPaths = new Map<string, string[]>();
  private readonly flooredAsks = new Set<string>();
  private readonly stdinTails = new Map<string, string>();

  constructor(
    private readonly rootDir: string,
    private readonly opts: OverseerTurnOptions
  ) {}

  async ask(
    approval: PendingCodexApproval,
    respond: (result: unknown) => void,
    controls: CodexTurnControls
  ): Promise<void> {
    let decision: ApprovalDecision;
    try {
      decision = await this.decide(approval);
    } catch (error) {
      decision = {
        allow: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    // Never acceptForSession: Dispatch's own grants decide the next ask.
    respond(approvalResult(approval, { allow: decision.allow }));
    const reason = decision.reason?.trim();
    if (!decision.allow && reason !== undefined && reason !== '') {
      controls.steer(`Dispatch did not run that: ${reason}`);
    }
  }

  private decide(approval: PendingCodexApproval): Promise<ApprovalDecision> {
    const toolName = CODEX_APPROVAL_TOOL_NAMES[approval.method];
    const view = approvalView(approval, this.editPaths);
    const floor = floorCheckForToolInput(view.input);
    const check = floor ?? holdFor(toolName, view, this.rootDir) ?? undefined;
    const params = objectValue(approval.params);
    if (floor !== null && typeof params?.itemId === 'string') {
      const kind = typeof params.kind === 'string' ? params.kind : 'command';
      this.flooredAsks.add(`${kind}:${params.itemId}`);
    }
    const self = selfDecision(
      this.opts.permissionMode,
      approval,
      view,
      check !== undefined,
      this.rootDir
    );
    if (self !== undefined) return Promise.resolve(self);
    if (this.opts.authorizeTool === undefined) {
      return Promise.resolve({
        allow: false,
        reason: 'no one is available to allow this in this session',
      });
    }
    // Unique across conversations: the manager keys every parked call by it.
    return this.opts.authorizeTool({
      requestId: `codex-approval-${randomUUID()}`,
      toolName,
      input: view.input,
      ...(check === undefined ? {} : { check }),
    });
  }

  watch(
    item: CodexItem,
    completed: boolean,
    controls: CodexTurnControls
  ): void {
    if (!completed) {
      this.started(item);
      return;
    }
    const bypass = unaskedFloorCommand(item, this.flooredAsks);
    if (bypass !== undefined) controls.fail(bypass);
  }

  // Codex asks before starting a shell but not about what is typed into it.
  typed(itemId: string, stdin: string, controls: CodexTurnControls): void {
    const lines = `${this.stdinTails.get(itemId) ?? ''}${stdin}`.split(
      /\r\n|\r|\n/
    );
    this.stdinTails.set(itemId, lines.pop() ?? '');
    if (this.flooredAsks.has(`writeStdin:${itemId}`)) return;
    for (const line of lines) {
      const check = floorCheckForCommand(line);
      if (check === null) continue;
      controls.fail(
        `Codex typed a floor command (${check}) into a shell it started, and Codex does not ask about shell input: ${line.trim()}. The Overseer turn is stopped so you can review it.`
      );
      return;
    }
  }

  // Keeps an edit's paths (its ask names none) and reports built-in calls.
  private started(item: CodexItem): void {
    if (item.type === 'fileChange') {
      const paths = fileChangePaths(item) ?? [];
      if (typeof item.id === 'string') this.editPaths.set(item.id, paths);
      this.opts.onToolUse?.('codex.fileChange', { paths });
      return;
    }
    if (item.type === 'commandExecution') {
      this.opts.onToolUse?.('codex.commandExecution', {
        command: commandText(item.command) ?? item.command,
        cwd: item.cwd,
      });
      return;
    }
    if (item.type === 'mcpToolCall') {
      this.opts.onToolUse?.(
        `mcp.${String(item.server)}.${String(item.tool)}`,
        item.arguments
      );
    }
  }
}

interface CodexOverseerOptions {
  spawnProcess?: SpawnCodexAppServer;
  cartoSpec?: (projectRoot: string) => StdioServerSpec | null;
  userMcpServers?: () => string[];
  pricing?: (projectRoot: string) => ExecutorPricing | undefined;
  env?: Record<string, string>;
}

// The overseer as a Codex thread in the checkout: registry tools are dynamic
// tools through `toolset.call`; Codex's commands and edits go through authorizeTool.
export class CodexOverseer implements OverseerBackend {
  constructor(
    private readonly rootDir: string,
    private readonly options: CodexOverseerOptions = {}
  ) {}

  start(
    prompt: string,
    toolset: OverseerToolset,
    options: OverseerTurnOptions = {}
  ): Promise<OverseerTurn> {
    return this.runTurn(prompt, toolset, undefined, options);
  }

  sendMessage(
    sessionId: string | undefined,
    message: string,
    toolset: OverseerToolset,
    options: OverseerTurnOptions = {}
  ): Promise<OverseerTurn> {
    return this.runTurn(message, toolset, sessionId, options);
  }

  // Codex keeps a thread's dynamic tools across resume (and ignores a resend),
  // so they are declared on thread/start only.
  private async runTurn(
    prompt: string,
    toolset: OverseerToolset,
    resume: string | undefined,
    opts: OverseerTurnOptions
  ): Promise<OverseerTurn> {
    const carto = (this.options.cartoSpec ?? cartoMcpSpec)(this.rootDir);
    const userServers = (
      this.options.userMcpServers ?? codexUserMcpServerNames
    )();
    const pricing = (this.options.pricing ?? codexPricingFor)(this.rootDir);
    const gate = new ApprovalGate(this.rootDir, opts);
    const callTool = (name: string, args: unknown) => toolset.call(name, args);
    const result = await runCodexTurn({
      cwd: this.rootDir,
      prompt,
      resumeThreadId: resume,
      model: opts.model,
      effort: codexEffort(opts.effort),
      permission: overseerPermission(opts.permissionMode),
      config: codexMcpConfig(carto === null ? {} : { carto }, userServers),
      developerInstructions: INSTRUCTIONS,
      dynamicTools: toolset.tools.map(dynamicTool),
      experimentalApi: true,
      signal: opts.abortController?.signal,
      spawnProcess: this.options.spawnProcess,
      env: this.options.env,
      onServerRequest: (request, respond, controls) => {
        if (claimCodexToolCall(callTool, request, respond)) return true;
        if (!isCodexApprovalMethod(request.method)) return false;
        void gate.ask(
          {
            method: request.method,
            params: request.params,
            providerRequestId: request.id,
          },
          respond,
          controls
        );
        return true;
      },
      onItem: (item, completed, controls) =>
        gate.watch(item, completed, controls),
      onTerminalInput: (itemId, stdin, controls) =>
        gate.typed(itemId, stdin, controls),
    });
    const reply = result.reply.trim();
    return {
      reply: reply === '' ? EMPTY_REPLY_MESSAGE : reply,
      sessionId: result.threadId,
      ...(pricing !== undefined && result.total !== undefined
        ? { costUsd: codexCostUsd(result.total, pricing) }
        : {}),
      ...(result.contextTokens === undefined
        ? {}
        : { contextTokens: result.contextTokens }),
    };
  }
}
