import { providerById, type SetupReport } from '@dispatch-foo/core/browser';

// Whether this machine finished Setup. localStorage, like reviewViewed: it's about
// this desk, not the project, and losing it only shows Setup once more.

const KEY = 'dispatch:setup-complete';

export function readSetupComplete(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? 'false') === true;
  } catch {
    return false;
  }
}

export function writeSetupComplete(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, 'true');
  } catch {
    // Blocked storage only means Setup shows again next launch.
  }
}

/** True when the first report finds nothing to fix, so Setup can finish silently. */
export function shouldAutoComplete(firstReport: SetupReport): boolean {
  return firstReport.steps.every((s) => s.status === 'ok');
}

/**
 * The first report's decision. An all-ok report may be ok on a fallback agent (the
 * configured one isn't installed), so finishing silently must also make it the default.
 */
export function autoCompleteAction(
  firstReport: SetupReport,
  configuredExecutor: string
): { complete: boolean; setDefault?: string } {
  if (!shouldAutoComplete(firstReport)) return { complete: false };
  const configured = providerById(configuredExecutor)?.id;
  const fallback = firstReport.defaultProvider;
  return configured !== undefined &&
    fallback !== null &&
    fallback !== configured
    ? { complete: true, setDefault: fallback }
    : { complete: true };
}

/** One project's setup report; scoped by daemon port so a project switch never reuses another's. */
export const setupReportKey = (port: number | undefined) =>
  ['setup', 'report', port ?? null] as const;

/** Reports re-run ~18 probes, so window focus reuses one under a minute old; installs invalidate. */
export const SETUP_REPORT_STALE_MS = 60_000;
