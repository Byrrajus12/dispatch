import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';
import type { ReactNode } from 'react';

import { TwoViewShell } from './TwoViewShell';
import type { TwoViewTopBarProps } from './TwoViewTopBar';

const topBar: TwoViewTopBarProps = {
  view: 'overseer',
  orb: { tone: 'amber', count: 0, spinning: false },
  orbLabel: 'Overseer',
  postsDot: false,
  onShowOverseer: () => {},
  onShowTasks: () => {},
  onCount: () => {},
  counts: { asks: 0, review: 0, failed: 0, working: 0 },
  settingsCount: 0,
  onOpenSettings: () => {},
  settingsOpen: false,
  onOpenDocs: () => {},
  onOpenThreads: () => {},
  threadsUnread: 0,
  page: null,
  projectMenu: <span>storefront</span>,
  trafficLightInset: false,
};

function shell(gate: ReactNode | null, peek: ReactNode = null) {
  return (
    <TwoViewShell
      topBar={topBar}
      view="tasks"
      gate={gate}
      overseer={<p>overseer</p>}
      tasks={<p>tasks</p>}
      peek={peek}
      guide={<p>guide card</p>}
    />
  );
}

test('the guide floats over the views and gives way to a gate screen', () => {
  const { rerender } = render(shell(null));
  expect(screen.getByTestId('first-task-guide-slot').textContent).toBe(
    'guide card'
  );
  rerender(shell(<p>setup</p>));
  expect(screen.queryByTestId('first-task-guide-slot')).toBeNull();
});

test('the guide steps aside while a peek drawer is open', () => {
  const { rerender } = render(shell(null, <aside>peek</aside>));
  expect(screen.queryByTestId('first-task-guide-slot')).toBeNull();
  rerender(shell(null));
  expect(screen.getByTestId('first-task-guide-slot')).toBeTruthy();
});
