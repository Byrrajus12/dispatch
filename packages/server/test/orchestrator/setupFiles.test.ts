import { describe, expect, it } from 'bun:test';

import { isDispatchSetupChange } from '../../src/orchestrator/setupFiles.js';

const ATTRS =
  '.dispatch/tasks/*.md merge=dispatch-task\n.dispatch/team.yml merge=dispatch-team\n';

describe('isDispatchSetupChange', () => {
  const cases: [string, string, string | undefined, string, boolean][] = [
    ['new .gitattributes from init', '.gitattributes', undefined, ATTRS, true],
    [
      'init lines appended to an existing file',
      '.gitattributes',
      '*.png binary\n',
      `*.png binary\n${ATTRS}`,
      true,
    ],
    [
      'an extra hand-written attribute',
      '.gitattributes',
      undefined,
      `${ATTRS}*.bin binary\n`,
      false,
    ],
    ['unchanged attributes', '.gitattributes', ATTRS, ATTRS, false],
    [
      'new .gitignore with only .carto/',
      '.gitignore',
      undefined,
      '.carto/\n',
      true,
    ],
    [
      '.carto/ appended without a trailing newline',
      '.gitignore',
      'node_modules',
      'node_modules\n.carto/\n',
      true,
    ],
    [
      '.gitignore with another line too',
      '.gitignore',
      undefined,
      '.carto/\n.env\n',
      false,
    ],
    ['any other path', 'README.md', undefined, 'hi\n', false],
  ];
  for (const [name, path, head, working, expected] of cases) {
    it(name, () => {
      expect(isDispatchSetupChange(path, head, working)).toBe(expected);
    });
  }
});
