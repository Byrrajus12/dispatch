import { describe, expect, test } from 'bun:test';

import { parseArgs } from '../src/args';

describe('parseArgs', () => {
  test('reads root and port from argv and the token from the environment', () => {
    expect(
      parseArgs(['--root', '/repo', '--port', '4100'], {
        DISPATCH_TUI_TOKEN: 'tok',
      })
    ).toEqual({
      ok: true,
      root: '/repo',
      port: 4100,
      token: 'tok',
      canDecide: false,
    });
  });

  test('DISPATCH_TUI_CAN_DECIDE=1 marks an app token', () => {
    const got = parseArgs(['--root', '/r', '--port', '1'], {
      DISPATCH_TUI_TOKEN: 't',
      DISPATCH_TUI_CAN_DECIDE: '1',
    });
    expect(got.ok && got.canDecide).toBe(true);
  });

  test('a missing token is an error that says how to launch it', () => {
    const got = parseArgs(['--root', '/repo', '--port', '4100'], {});
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain('dispatch tui');
  });

  test('a port that is not a number is an error', () => {
    const got = parseArgs(['--root', '/repo', '--port', 'abc'], {
      DISPATCH_TUI_TOKEN: 't',
    });
    expect(got.ok).toBe(false);
  });

  test('a missing root is an error', () => {
    expect(parseArgs(['--port', '1'], { DISPATCH_TUI_TOKEN: 't' }).ok).toBe(
      false
    );
  });
});
