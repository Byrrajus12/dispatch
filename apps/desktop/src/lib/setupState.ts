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
