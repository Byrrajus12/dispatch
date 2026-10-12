import { color } from '../theme';

const LINES = [
  '1 overseer   2 tasks   3 runs   4 docs   5 threads   6 prs',
  'ctrl+p   switch project',
  'tab / shift+tab   move between columns',
  'j / k, arrows   move within a list or between cards',
  'i or /   type to the Overseer   esc   stop typing',
  'y / n   approve or reject the focused card',
  'd   the diff (Runs, PRs)   [ ]   side columns when narrow',
  '?   this help   q / ctrl+c   quit',
];

export function Help() {
  return (
    <box
      border
      title=" keys "
      padding={1}
      flexDirection="column"
      borderColor={color.accent}
    >
      {LINES.map((line) => (
        <text key={line} fg={color.text}>
          {line}
        </text>
      ))}
      <text fg={color.dim}>esc to close</text>
    </box>
  );
}
