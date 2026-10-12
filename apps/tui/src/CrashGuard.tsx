import { useKeyboard } from '@opentui/react';
import { Component, type ReactNode } from 'react';

import { safeText } from './safe';
import { color } from './theme';

// The crash screen keeps its own keyboard handler, since the app's went down with it.
function Crashed({ message, onQuit }: { message: string; onQuit: () => void }) {
  useKeyboard((event) => {
    if (event.name === 'q' || (event.ctrl && event.name === 'c')) onQuit();
  });
  return (
    <box flexDirection="column" padding={1}>
      <text fg={color.bad}>{`The TUI hit an error: ${safeText(message)}`}</text>
      <text fg={color.dim}>
        Press q to quit; dispatchd and its runs are unaffected.
      </text>
    </box>
  );
}

/** Catches a render crash so the terminal is never left frozen with no way out. */
export class CrashGuard extends Component<
  { onQuit: () => void; children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    return this.state.error === null ? (
      this.props.children
    ) : (
      <Crashed message={this.state.error.message} onQuit={this.props.onQuit} />
    );
  }
}
