export type TuiArgs =
  | { ok: true; root: string; port: number; token: string }
  | { ok: false; error: string };

const LAUNCH_HINT =
  'Start it with `dispatch tui`, which finds or starts dispatchd for you.';

/** Reads `--root`/`--port` from argv and the daemon token from the environment, never argv. */
export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>
): TuiArgs {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const root = value('--root');
  const rawPort = value('--port');
  const port = Number(rawPort);
  const token = env.DISPATCH_TUI_TOKEN;
  if (root === undefined || root === '') {
    return { ok: false, error: `No project root given. ${LAUNCH_HINT}` };
  }
  if (rawPort === undefined || !Number.isInteger(port) || port <= 0) {
    return { ok: false, error: `No valid daemon port given. ${LAUNCH_HINT}` };
  }
  if (token === undefined || token === '') {
    return { ok: false, error: `No daemon token given. ${LAUNCH_HINT}` };
  }
  return { ok: true, root, port, token };
}
