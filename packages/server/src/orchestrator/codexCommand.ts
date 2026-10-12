import type { FloorCheck } from '@dispatch-foo/core';
import { basename } from 'node:path';

import { dequotedCommand, floorCheckForToolInput } from '../floor.js';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
// Short option clusters that take no argument (`-o`/`-O` take one); a long or
// argument-taking option could change what runs, so it is never unwrapped.
const SHELL_FLAG = /^-[a-np-zA-NP-Z]+$/;
const COMMAND_FLAG = /^-[a-np-zA-NP-Z]*c[a-np-zA-NP-Z]*$/;
const MAX_UNWRAP_DEPTH = 4;
// What still hides the program that runs once the wrappers are off: a shell
// `-c` anywhere, a substitution, a variable or a wrapper program in command position.
const OPAQUE_COMMAND = [
  /(?:^|[^\w.-])(?:sh|bash|zsh|dash|ksh|fish)(?:\s+\S+)*?\s+-[A-Za-z]*c[A-Za-z]*(?=\s|$)/,
  /\$\(|`/,
  /(?:^|[;&|(\n])\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\$|(?:\S*\/)?(?:env|exec|command|builtin|xargs|sudo|doas|su|nice|nohup|time|timeout|stdbuf|ionice|chroot|watch|eval|source|\.)(?=\s|$))/,
];
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
        const next = command[i + 1] ?? '';
        if (command[i] === '\\' && /["\\$`\n]/.test(next)) {
          // A backslash-newline inside double quotes is a line continuation.
          if (next !== '\n') text += next;
          i += 2;
          continue;
        }
        if (/[$`]/.test(command[i])) return undefined;
        text += command[i];
        i += 1;
      }
      if (i >= command.length) return undefined;
      word = (word ?? '') + text;
      i += 1;
    } else if (char === '\\') {
      if (i + 1 >= command.length) return undefined;
      if (command[i + 1] !== '\n') word = (word ?? '') + command[i + 1];
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

/** A Codex command read for holds, floor checks and grants. */
export interface CodexCommandReading {
  text: string;
  /** False when the text may still hide what runs; such a command always asks. */
  known: boolean;
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
  const text = current;
  const plain = dequotedCommand(text);
  const opaque = OPAQUE_COMMAND.some(
    (pattern) => pattern.test(text) || pattern.test(plain)
  );
  return { text, known: !exhausted && !opaque };
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
  return reading === undefined
    ? null
    : floorCheckForToolInput({ command: reading.text });
}

/**
 * True when a Codex command ask must reach a human however it is otherwise
 * answered: it trips the floor, or what it runs cannot be read.
 */
export function codexCommandNeedsHuman(command: unknown): boolean {
  const reading = readCodexCommand(command);
  return (
    reading === undefined ||
    !reading.known ||
    codexCommandFloor(command) !== null
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
