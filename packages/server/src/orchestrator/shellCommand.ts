import { basename } from 'node:path';

import { decodeAnsiC, dequotedCommand, FLOOR_PROGRAMS } from '../floor.js';

/**
 * Reading shell command lines for approvals: one linear word splitter, the
 * allowlist of commands simple enough to answer without a human, and the
 * tokens holds and floor guards scan. Everything here errs toward "ask".
 */

/** Longest command the allowlist will call simple; anything longer asks. */
const MAX_SIMPLE_LENGTH = 4096;

const SHELL_OPERATOR = /[;&|<>()`$\n]/;

// A command line split into words, or undefined when it holds anything beyond
// plain and quoted words (an operator, a substitution, an unclosed quote).
export function shellWords(command: string): string[] | undefined {
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

// Anything but printable ASCII and tabs: control characters, NUL, look-alike
// letters and exotic spaces all leave a command not simple.
const NON_PLAIN_TEXT = /[^\x20-\x7e\t]/;
// Shell syntax that can run, redirect, expand or hide more than one program
// with its arguments; `#` (a comment) hides text from a reader, not the shell.
const SHELL_SYNTAX = /[;&|$`(){}<>!#\n\r]/;
// Globs or an assignment where the program goes could run something unnamed.
const UNNAMED_PROGRAM = /[*?[\]=~]/;

// Programs that run another program, code given as text, or shell syntax of
// their own: their name says nothing about what will run.
const RUNNERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'mksh',
  'fish',
  'csh',
  'tcsh',
  'eval',
  'exec',
  'command',
  'builtin',
  'env',
  'xargs',
  'sudo',
  'doas',
  'su',
  'nice',
  'nohup',
  'timeout',
  'caffeinate',
  'script',
  'arch',
  'time',
  'stdbuf',
  'ionice',
  'chroot',
  'watch',
  'coproc',
  'noglob',
  'nocorrect',
  '.',
  'source',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'while',
  'until',
  'for',
  'do',
  'done',
  'case',
  'esac',
  'select',
  'function',
  '[[',
]);

// Interpreters that run code passed as an argument (`node -e`, `python -c`).
const INTERPRETERS = new Set([
  'node',
  'nodejs',
  'bun',
  'deno',
  'python',
  'python2',
  'python3',
  'ruby',
  'perl',
  'php',
  'lua',
  'luajit',
  'rscript',
  'osascript',
  'pwsh',
  'powershell',
  'tclsh',
  'awk',
  'gawk',
  'mawk',
  'nawk',
]);
const INLINE_CODE_FLAG =
  /^(?:-[A-Za-z]*[ecpEC][A-Za-z]*|--(?:eval|print|command|exec)\b.*|-|eval)$/;
const FIND_EXEC = /^-(?:exec|execdir|ok|okdir)$/;
// git options that run a configured or given program.
const GIT_EXEC_OPTION =
  /^(?:-c|--config-env|--exec-path|--upload-pack|--receive-pack)/;

/** A program's name as a case-insensitive filesystem resolves it. */
export function programName(word: string): string {
  return basename(word).toLowerCase();
}

/**
 * True for a command that is one program with plain arguments: no shell
 * syntax, no wrapper or inline-code runner, nothing that names a program the
 * reader cannot see. Only such a command may be answered without a human, or
 * granted by its program's name.
 */
export function isSimpleCommand(command: string): boolean {
  if (
    command.length > MAX_SIMPLE_LENGTH ||
    NON_PLAIN_TEXT.test(command) ||
    SHELL_SYNTAX.test(command)
  ) {
    return false;
  }
  const words = shellWords(command);
  if (words === undefined || words.length === 0) return false;
  const [first, ...args] = words;
  if (first === '' || UNNAMED_PROGRAM.test(first)) return false;
  const program = programName(first);
  if (RUNNERS.has(program)) return false;
  if (program === 'find' && args.some((arg) => FIND_EXEC.test(arg))) {
    return false;
  }
  if (
    INTERPRETERS.has(program) &&
    args.some((arg) => INLINE_CODE_FLAG.test(arg))
  ) {
    return false;
  }
  if (program === 'git' && args.some((arg) => GIT_EXEC_OPTION.test(arg))) {
    return false;
  }
  return true;
}

// Where the shell ends one word: whitespace and its syntax characters. `=`
// and `,` split too, so `alias.x=!dispatch` or `--path=.dispatch` surface.
const TOKEN_BREAK = /[\s;&|()<>{}`$=!,"']+/;

/** The words of a command as the shell would spell them, split at all syntax; linear time. */
export function commandTokens(command: string): string[] {
  return dequotedCommand(command)
    .split(TOKEN_BREAK)
    .filter((token) => token !== '');
}

/** One shell word as the shell spells it, and how the scanner met it. */
interface ScannedWord {
  text: string;
  /** Holds `$(`, a backtick or a `$` expansion the shell would expand. */
  expands: boolean;
  /** The target of a redirection (`> file`), never the program. */
  target: boolean;
}

// Characters that end a command outside quotes; `{`, `}`, `!` and `$(` count
// too, so a reader errs toward seeing a new command where the shell might not.
const COMMAND_BREAK = new Set([
  ';',
  '&',
  '|',
  '(',
  ')',
  '{',
  '}',
  '`',
  '\n',
  '!',
]);
// Words after which the next word is a command again.
const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
]);
// Package-manager subcommands that run the next word as a program.
const PACKAGE_RUN = new Set(['exec', 'dlx', 'x', 'run', 'create']);
const RUN_PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Programs that run text they read (a pipe, a here-doc, a file): with one in a
// line, any word of the line may end up run.
const TEXT_RUNNERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'mksh',
  'fish',
  'csh',
  'tcsh',
  'eval',
  'source',
  '.',
  'xargs',
]);

// The commands of a line as lists of words, split the way the shell splits
// them: quotes kept together, `$'…'` decoded, escapes applied. A comment's text
// is handed to `onComment` (it is not scanned for comments again, which keeps
// this linear). Undefined for a line that does not parse (an unclosed quote).
function scanCommands(
  command: string,
  onComment?: (text: string) => void
): ScannedWord[][] | undefined {
  const commands: ScannedWord[][] = [[]];
  let text = '';
  let started = false;
  let quoted = false;
  let expands = false;
  let pendingTarget = false;
  const finish = (): void => {
    if (started) {
      commands[commands.length - 1].push({
        text,
        expands,
        target: pendingTarget,
      });
      pendingTarget = false;
    }
    text = '';
    started = false;
    quoted = false;
    expands = false;
  };
  let i = 0;
  while (i < command.length) {
    const char = command[i];
    const next = command[i + 1] ?? '';
    if (char === ' ' || char === '\t') {
      finish();
      i += 1;
    } else if (char === '<' || char === '>') {
      // An fd number glued to the operator (`2>`) is not a word.
      if (started && !quoted && /^\d+$/.test(text)) {
        text = '';
        started = false;
      }
      finish();
      while (i < command.length && /[<>&|]/.test(command[i])) i += 1;
      pendingTarget = true;
    } else if (char === '#' && !started && onComment !== undefined) {
      // A comment runs to the end of the line; a shell that does not take it
      // as one would run its text, so that text is still read for commands.
      const end = command.indexOf('\n', i);
      onComment(command.slice(i + 1, end === -1 ? command.length : end));
      i = end === -1 ? command.length : end;
    } else if (char === '$' && next === '{') {
      const close = command.indexOf('}', i + 2);
      if (close === -1) return undefined;
      text += command.slice(i, close + 1);
      started = true;
      expands = true;
      i = close + 1;
    } else if (char === '$' && next === '(') {
      finish();
      commands.push([]);
      i += 2;
    } else if (COMMAND_BREAK.has(char)) {
      finish();
      pendingTarget = false;
      commands.push([]);
      i += 1;
    } else if (char === '\\') {
      if (i + 1 >= command.length) return undefined;
      if (next !== '\n') text += next;
      started = true;
      i += 2;
    } else if (char === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return undefined;
      text += command.slice(i + 1, close);
      started = true;
      quoted = true;
      i = close + 1;
    } else if (char === '$' && next === "'") {
      let j = i + 2;
      let body = '';
      while (j < command.length && command[j] !== "'") {
        body += command[j];
        if (command[j] === '\\' && j + 1 < command.length) {
          body += command[j + 1];
          j += 1;
        }
        j += 1;
      }
      if (j >= command.length) return undefined;
      text += decodeAnsiC(body);
      started = true;
      quoted = true;
      i = j + 1;
    } else if (char === '"' || (char === '$' && next === '"')) {
      let j = char === '"' ? i + 1 : i + 2;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) {
          if (command[j + 1] !== '\n') text += command[j + 1];
          j += 2;
          continue;
        }
        if (command[j] === '$' || command[j] === '`') expands = true;
        text += command[j];
        j += 1;
      }
      if (j >= command.length) return undefined;
      started = true;
      quoted = true;
      i = j + 1;
    } else {
      if (char === '$') expands = true;
      text += char;
      started = true;
      i += 1;
    }
  }
  finish();
  return commands.filter((words) => words.length > 0);
}

// Whether a command's program runs (some of) its arguments as commands.
function runsItsArguments(
  program: string,
  args: readonly ScannedWord[]
): boolean {
  const first = args.find((arg) => !arg.target)?.text.toLowerCase() ?? '';
  return (
    RUNNERS.has(program) ||
    program === 'npx' ||
    program === 'bunx' ||
    program === 'pnpx' ||
    (RUN_PACKAGE_MANAGERS.has(program) && PACKAGE_RUN.has(first)) ||
    (program === 'find' && args.some((arg) => FIND_EXEC.test(arg.text))) ||
    (program === 'git' && args.some((arg) => GIT_EXEC_OPTION.test(arg.text))) ||
    (INTERPRETERS.has(program) &&
      args.some((arg) => INLINE_CODE_FLAG.test(arg.text)))
  );
}

/**
 * The lowercased names a line may run as programs: each command's program
 * word (past assignments, keywords and redirects), every token of a word
 * an expansion builds, and every token after a program that runs its
 * arguments (`sudo`, `xargs`, `sh -c`, `npx`, `find -exec`). A line that does
 * not parse gives every token. Plain arguments never count.
 */
export function commandPositionNames(command: string): string[] {
  return namesFrom(command, true);
}

function namesFrom(command: string, readComments: boolean): string[] {
  const names: string[] = [];
  const commands = scanCommands(
    command,
    readComments
      ? (comment) => names.push(...namesFrom(comment, false))
      : undefined
  );
  if (commands === undefined) return commandTokens(command).map(programName);
  let readsText = false;
  for (const words of commands) {
    let at = 0;
    while (
      at < words.length &&
      (words[at].target ||
        ASSIGNMENT.test(words[at].text) ||
        KEYWORDS.has(words[at].text.toLowerCase()))
    ) {
      if (words[at].expands)
        names.push(...commandTokens(words[at].text).map(programName));
      at += 1;
    }
    const program = words[at];
    if (program === undefined) continue;
    const name = programName(program.text);
    names.push(name);
    if (program.expands)
      names.push(...commandTokens(program.text).map(programName));
    const args = words.slice(at + 1);
    for (const arg of args) {
      if (arg.expands && !arg.target) {
        // `"$(…)"` inside an argument still runs a command.
        if (/\$\(|`/.test(arg.text))
          names.push(...commandTokens(arg.text).map(programName));
      }
    }
    if (TEXT_RUNNERS.has(name)) readsText = true;
    if (runsItsArguments(name, args)) {
      for (const arg of args)
        names.push(...commandTokens(arg.text).map(programName));
    }
  }
  // `echo dispatch x | sh` runs the echoed words.
  if (readsText) names.push(...commandTokens(command).map(programName));
  return names;
}

const GLOB = /[*?[]/;
const MAX_GLOB_LENGTH = 64;
const globCache = new Map<string, RegExp | null>();

/**
 * Whether a word names `name` case-insensitively, or is a glob that could
 * expand to it. A glob too long to compile cheaply counts as a match.
 */
export function globMatches(word: string, name: string): boolean {
  const lower = word.toLowerCase();
  if (lower === name) return true;
  if (!GLOB.test(lower)) return false;
  // A glob matches a leading dot only with a literal one (`.disp*`, not `*`).
  if (name.startsWith('.') && !lower.startsWith('.')) return false;
  if (lower.length > MAX_GLOB_LENGTH) return true;
  let pattern = globCache.get(lower);
  if (pattern === undefined) {
    const source = lower
      .replace(/[.+^${}()|\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
      .replace(/\[!/g, '[^');
    try {
      pattern = new RegExp(`^${source}$`);
    } catch {
      pattern = null;
    }
    globCache.set(lower, pattern);
  }
  return pattern === null || pattern.test(name);
}

// Tokens that, inside a command the reader cannot fully see, may build or
// run a floor act: git, gh, rm, Dispatch, download tools, the floor's verbs, and
// programs that turn text into names or run it.
const ALWAYS_RELEVANT_NAMES = [
  'git',
  'gh',
  'rm',
  'dispatch',
  'dispatch-cli',
  'curl',
  'wget',
  'push',
  'publish',
  'unpublish',
  'release',
  'eval',
  'source',
  'printf',
  'base64',
  'xxd',
  'rev',
  'tr',
  'od',
  'openssl',
  'uudecode',
];
const ALWAYS_RELEVANT = new Set(ALWAYS_RELEVANT_NAMES);
// Package managers publish only with a `publish` word, which an expansion
// (`$(…)`, a variable, backticks) can spell without showing it.
const PACKAGE_MANAGERS = new Set(
  [...FLOOR_PROGRAMS, 'bunx'].filter((name) => name !== 'git' && name !== 'gh')
);
const EXPANSION = /[$`]/;
// An escape `$'…'` or printf could turn into any name.
const ESCAPE_CODE = /\\(?:x[0-9a-fA-F]|u[0-9a-fA-F]|U[0-9a-fA-F]|[0-7])/;

// Whether a segment names a package manager with an expansion after it, where
// `$(…)` could spell its subcommand (`pnpm $(echo publish)`); one before it
// (`FOO=$(date) pnpm test`) cannot.
function expandsAfterPackageManager(command: string): boolean {
  return command.split(/[;&|\n]/).some((segment) => {
    const lower = segment.toLowerCase();
    const expansion = Math.max(lower.lastIndexOf('$'), lower.lastIndexOf('`'));
    if (expansion === -1) return false;
    return commandTokens(segment).some((token) => {
      const name = programName(token);
      return PACKAGE_MANAGERS.has(name) && lower.indexOf(name) < expansion;
    });
  });
}

/**
 * For a command that is not simple: true when it could still reach a floor
 * act, so an unattended run must wait for a human rather than proceed.
 */
export function mayHideFloorAct(command: string): boolean {
  if (ESCAPE_CODE.test(command)) return true;
  const tokens = commandTokens(command);
  const names = tokens.map(programName);
  const relevant = (name: string): boolean =>
    ALWAYS_RELEVANT.has(name) ||
    (GLOB.test(name) &&
      ALWAYS_RELEVANT_NAMES.some((word) => globMatches(name, word)));
  if (names.some(relevant)) return true;
  if (EXPANSION.test(command) && expandsAfterPackageManager(command)) {
    return true;
  }
  return (
    names.some((name) => INTERPRETERS.has(name)) &&
    tokens.some((token) => INLINE_CODE_FLAG.test(token))
  );
}
