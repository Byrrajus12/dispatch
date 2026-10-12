import {
  GITATTRIBUTES_LINE,
  mergeGitAttributes,
  TEAM_GITATTRIBUTES_LINE,
} from '@dispatch-foo/core';

// The files outside `.dispatch/` that Dispatch's own project init edits:
// the merge-driver lines in .gitattributes and carto's `.carto/` ignore line.
export const SETUP_FILE_PATHS = ['.gitattributes', '.gitignore'] as const;

// Whether `working` is exactly what Dispatch's init writes on top of `head`
// (the committed text, or undefined when the file is new), so committing it
// can never sweep up an edit the user made by hand.
export function isDispatchSetupChange(
  path: string,
  head: string | undefined,
  working: string
): boolean {
  if (path === '.gitattributes') {
    const expected = mergeGitAttributes(
      mergeGitAttributes(head, GITATTRIBUTES_LINE),
      TEAM_GITATTRIBUTES_LINE
    );
    return working === expected && working !== head;
  }
  if (path === '.gitignore') {
    const base = head ?? '';
    if (/^\.carto\/?\s*$/m.test(base)) return false;
    const prefix = base.length > 0 && !base.endsWith('\n') ? '\n' : '';
    return working === `${base}${prefix}.carto/\n`;
  }
  return false;
}
