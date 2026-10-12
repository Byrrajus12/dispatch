import type { ApiClient } from '@dispatch/client';

import { usePrs } from '../data';
import { safeText } from '../safe';
import { color } from '../theme';
import { List } from './List';
import { Patch } from './Patch';

/** Open pull requests; the selected one's checks and conversation, or its diff (d). */
export function PrsView({
  client,
  port,
  cursor,
  diff,
}: {
  client: ApiClient;
  port: number;
  cursor: number;
  diff: boolean;
}) {
  const first = usePrs(client, port, null, false);
  const selected = first.prs[cursor];
  const { detail, patch } = usePrs(
    client,
    port,
    selected?.number ?? null,
    diff
  );
  const checks = detail?.status.checks;
  return (
    <box flexDirection="row" flexGrow={1}>
      <List
        title="Pull requests"
        rows={first.prs.map((p) => ({
          key: String(p.number),
          label: `#${p.number} ${p.isDraft ? '(draft) ' : ''}${p.title}`,
        }))}
        cursor={cursor}
        focused
        empty="no open pull requests"
        width="40%"
      />
      <box
        border
        title={diff ? ' diff ' : ' pull request '}
        borderColor={color.dim}
        flexDirection="column"
        flexGrow={1}
        paddingLeft={1}
        paddingRight={1}
      >
        {selected === undefined ? (
          <text fg={color.dim}>Pick a pull request with j / k.</text>
        ) : diff ? (
          patch === null ? (
            <text fg={color.dim}>loading diff…</text>
          ) : (
            <Patch patch={patch} />
          )
        ) : detail === null ? (
          <text fg={color.dim}>loading…</text>
        ) : (
          <scrollbox flexGrow={1}>
            <text fg={color.text}>
              {safeText(`#${detail.status.number}  ${detail.status.title}`)}
            </text>
            <text
              fg={
                detail.status.mergeable === 'CONFLICTING'
                  ? color.bad
                  : color.dim
              }
            >
              {`${detail.status.state.toLowerCase()} · ${(detail.status.reviewDecision ?? 'no review').toLowerCase().replace('_', ' ')} · ${detail.status.mergeable?.toLowerCase() ?? 'mergeability unknown'}`}
            </text>
            {checks !== undefined && (
              <text
                fg={
                  checks.failed > 0
                    ? color.bad
                    : checks.pending > 0
                      ? color.warn
                      : color.ok
                }
              >
                {`${checks.passed}/${checks.total} checks passed${checks.failed > 0 ? ` · ${checks.failed} failed` : ''}${checks.pending > 0 ? ` · ${checks.pending} pending` : ''}`}
              </text>
            )}
            {detail.conversation.map((c, i) => (
              <text key={i} fg={color.text}>
                {safeText(`${c.author}: ${c.body}`)}
              </text>
            ))}
            <text fg={color.dim}>d to see the diff</text>
          </scrollbox>
        )}
      </box>
    </box>
  );
}
