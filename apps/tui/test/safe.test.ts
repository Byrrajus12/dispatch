import { describe, expect, test } from 'bun:test';

import { safeText } from '../src/safe';

describe('safeText', () => {
  test('keeps ordinary text, newlines and unicode', () => {
    expect(safeText('Fix the cart\n— and ✓ it')).toBe(
      'Fix the cart\n— and ✓ it'
    );
  });

  test('drops CSI sequences such as colours and cursor moves', () => {
    expect(safeText('a\x1b[31mred\x1b[0m\x1b[2J b')).toBe('ared b');
  });

  test('drops OSC sequences such as clipboard writes and title changes', () => {
    expect(safeText('x\x1b]52;c;ZXZpbA==\x07y\x1b]0;pwned\x1b\\z')).toBe('xyz');
  });

  test('drops other control characters, including C1 and a lone ESC', () => {
    expect(safeText('a\x00b\x07c\x1bd\x9be\x7ff')).toBe('abcdef');
  });

  test('expands tabs and normalises carriage returns', () => {
    expect(safeText('a\tb\r\nc\rd')).toBe('a  b\nc\nd');
  });
});
