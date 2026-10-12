import { safeText } from '../safe';
import { color } from '../theme';

/** A unified diff, line by line, coloured like `git diff`. */
export function Patch({ patch }: { patch: string }) {
  if (patch.trim() === '') return <text fg={color.dim}>No changes.</text>;
  return (
    <scrollbox flexGrow={1}>
      {patch.split('\n').map((line, i) => (
        <text
          key={i}
          fg={
            line.startsWith('+')
              ? color.ok
              : line.startsWith('-')
                ? color.bad
                : line.startsWith('@@') || line.startsWith('diff ')
                  ? color.accent
                  : color.text
          }
        >
          {line === '' ? ' ' : safeText(line)}
        </text>
      ))}
    </scrollbox>
  );
}
