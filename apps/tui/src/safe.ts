// Text from outside (PR comments, agent output, notes, diffs) may carry terminal control
// sequences that would repaint the screen, set the window title or write the clipboard.
const ESC = 0x1b;
const BEL = 0x07;

// Index just past the escape sequence that starts at `i` (which holds ESC).
function skipEscape(text: string, i: number): number {
  const kind = text[i + 1];
  if (kind === '[') {
    // CSI: parameters and intermediates, ended by one byte in @..~.
    let j = i + 2;
    while (j < text.length) {
      const code = text.charCodeAt(j);
      j++;
      if (code >= 0x40 && code <= 0x7e) break;
    }
    return j;
  }
  if (kind === ']') {
    // OSC: runs to BEL or ESC \.
    let j = i + 2;
    while (j < text.length) {
      const code = text.charCodeAt(j);
      if (code === BEL) return j + 1;
      if (code === ESC && text[j + 1] === '\\') return j + 2;
      j++;
    }
    return j;
  }
  // Any other ESC + byte pair, or a lone ESC.
  const next = text.charCodeAt(i + 1);
  return next >= 0x40 && next <= 0x5f ? i + 2 : i + 1;
}

/** Untrusted text made safe to draw: escapes and control characters gone, newlines kept. */
export function safeText(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === ESC) {
      i = skipEscape(text, i);
      continue;
    }
    const ch = text[i] ?? '';
    if (ch === '\r') {
      out += '\n';
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '\t') out += '  ';
    else if (ch === '\n' || !(code < 0x20 || (code >= 0x7f && code <= 0x9f)))
      out += ch;
    i++;
  }
  return out;
}
