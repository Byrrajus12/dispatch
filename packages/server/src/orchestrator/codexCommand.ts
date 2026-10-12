import type { FloorCheck } from '@dispatch-foo/core';
import { basename } from 'node:path';

import { floorCheckForToolInput } from '../floor.js';
import {
  isSimpleCommand,
  mayHideFloorAct,
  shellWords,
} from './shellCommand.js';

// POSIX-family shells whose `-c` script the reader can parse with the same
// rules; fish and csh quote differently, so they are never unwrapped.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh']);
// Short option clusters that take no argument (`-o`/`-O` take one); a long or
// argument-taking option could change what runs, so it is never unwrapped.
const SHELL_FLAG = /^-[a-np-zA-NP-Z]+$/;
const COMMAND_FLAG = /^-[a-np-zA-NP-Z]*c[a-np-zA-NP-Z]*$/;
const MAX_UNWRAP_DEPTH = 4;
const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

// The script of `<shell> [-flags] -c '<script>'`, the form Codex runs nearly every command in.
function shellScript(words: readonly string[]): string | undefined {
  if (words.length < 3 || !SHELLS.has(basename(words[0]).toLowerCase())) {
    return undefined;
  }
  const flags = words.slice(1, -1);
  return flags.every((flag) => SHELL_FLAG.test(flag)) &&
    flags.some((flag) => COMMAND_FLAG.test(flag))
    ? words.at(-1)
    : undefined;
}

function quoted(word: string): string {
  return PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** A Codex command read for holds, floor checks and grants. */
export interface CodexCommandReading {
  text: string;
  /**
   * True only for one program with plain arguments once the shell wrappers
   * are off (isSimpleCommand); anything else may hide what runs and asks.
   */
  simple: boolean;
}

/**
 * A Codex command as the one string holds, floor checks and grants read: a
 * shell wrapper (string or argv) unwrapped to its script, an argv joined.
 * Undefined when there is no command to read, which callers treat as unknown.
 */
export function readCodexCommand(
  command: unknown
): CodexCommandReading | undefined {
  let current: string | undefined;
  if (typeof command === 'string') current = command;
  else if (
    Array.isArray(command) &&
    command.length > 0 &&
    command.every((word) => typeof word === 'string')
  ) {
    current = shellScript(command) ?? command.map(quoted).join(' ');
  }
  if (current === undefined) return undefined;
  // Unwrap nested wrappers (`bash -lc "sh -c '…'"`) a few levels deep.
  let exhausted = true;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    const words = shellWords(current);
    const script = words === undefined ? undefined : shellScript(words);
    if (script === undefined) {
      exhausted = false;
      break;
    }
    current = script;
  }
  if (current.trim() === '') return undefined;
  return { text: current, simple: !exhausted && isSimpleCommand(current) };
}

/**
 * The floor check a Codex command trips, read both as sent and as the script
 * its shell wrappers run, so an argv or a quoted-apart name is still caught.
 */
export function codexCommandFloor(command: unknown): FloorCheck | null {
  const asSent =
    typeof command === 'string' ? floorCheckForToolInput({ command }) : null;
  if (asSent !== null) return asSent;
  const reading = readCodexCommand(command);
  return reading === undefined || reading.text === command
    ? null
    : floorCheckForToolInput({ command: reading.text });
}

/**
 * True when a run's Codex command ask must reach a human however it is
 * otherwise answered: it is unreadable, trips the floor, or is not simple and
 * may hide a floor act. Runs work in their own worktree, so a non-simple
 * command with no floor-relevant part may proceed; the Overseer, in the main
 * checkout, asks about every non-simple command instead.
 */
export function codexCommandNeedsHuman(command: unknown): boolean {
  const reading = readCodexCommand(command);
  if (reading === undefined || codexCommandFloor(command) !== null) return true;
  if (reading.simple) return false;
  return (
    mayHideFloorAct(reading.text) ||
    (typeof command === 'string' &&
      command !== reading.text &&
      mayHideFloorAct(command))
  );
}

/**
 * For the policy's automatic answers: true when a run's Codex command ask
 * must still go to a human (see codexCommandNeedsHuman); false for other tools.
 */
export function codexApprovalNeedsHuman(
  toolName: string,
  input: unknown
): boolean {
  if (toolName !== 'codex.commandExecution') return false;
  const command =
    typeof input === 'object' && input !== null
      ? (input as { command?: unknown }).command
      : undefined;
  return codexCommandNeedsHuman(command);
}
