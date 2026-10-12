import { color } from '../theme';

/** A titled column of one-line rows; the cursor row is highlighted only while the column has focus. */
export function List({
  title,
  rows,
  cursor,
  focused,
  empty,
  width,
}: {
  title: string;
  rows: { key: string; label: string; tone?: string }[];
  cursor: number;
  focused: boolean;
  empty: string;
  width?: number | `${number}%`;
}) {
  return (
    <box
      border
      title={` ${title} ${rows.length} `}
      borderColor={focused ? color.accent : color.dim}
      flexDirection="column"
      width={width}
      flexGrow={width === undefined ? 1 : 0}
      flexShrink={width === undefined ? 1 : 0}
      paddingLeft={1}
      paddingRight={1}
    >
      {rows.length === 0 ? (
        <text fg={color.dim}>{empty}</text>
      ) : (
        rows.map((row, i) => (
          <text
            key={row.key}
            wrapMode="none"
            fg={row.tone ?? color.text}
            bg={focused && i === cursor ? color.focus : undefined}
          >
            {`${focused && i === cursor ? '▸ ' : '  '}${row.label}`}
          </text>
        ))
      )}
    </box>
  );
}
