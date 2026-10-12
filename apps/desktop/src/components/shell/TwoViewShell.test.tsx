import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';
import { type ReactNode, useState } from 'react';

import { FirstTaskGuide } from '../guide/FirstTaskGuide';
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

// Fakes the main area's measured width, since the test DOM has no layout.
const realWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'clientWidth'
);
function mainWidth(px: number) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => px,
  });
}
afterEach(() => {
  if (realWidth !== undefined) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', realWidth);
  }
});

// A guide card whose expand/collapse choice lives in state, like the app's hook.
function GuideHarness() {
  const [collapsed, setCollapsed] = useState<boolean | null>(null);
  const noop = () => {};
  const card = (
    <FirstTaskGuide
      view={{ stage: 'describe' }}
      provider={null}
      sendOptions={{ modelChoice: false }}
      sendError={null}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
      actions={{
        showDescribe: noop,
        openDraft: noop,
        openTask: noop,
        send: () => Promise.resolve(),
        retryDraft: () => Promise.resolve(),
        retryRun: () => Promise.resolve(),
        askAgentToFix: () => Promise.resolve(),
        looksGood: noop,
        askForChanges: () => Promise.resolve(),
        land: () => Promise.resolve(),
        startOver: () => Promise.resolve(),
        dismiss: noop,
        closeCompletion: noop,
        openBoard: noop,
        openOverseer: noop,
        inviteTeammate: noop,
      }}
    />
  );
  return (
    <TwoViewShell
      topBar={topBar}
      view="overseer"
      gate={null}
      overseer={<p>overseer</p>}
      tasks={<p>tasks</p>}
      peek={null}
      guide={card}
    />
  );
}

test('the guide starts collapsed when the main area is narrow, and stays open once expanded', () => {
  mainWidth(640);
  render(<GuideHarness />);
  expect(screen.getByText(/^Your first task · Step 1/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Expand the guide' }));
  expect(
    screen.getByRole('button', { name: 'Collapse the guide' })
  ).toBeTruthy();
  expect(screen.queryByText(/^Your first task · Step/)).toBeNull();
});

test('the guide starts expanded when the main area is wide', () => {
  mainWidth(1280);
  render(<GuideHarness />);
  expect(
    screen.getByRole('button', { name: 'Collapse the guide' })
  ).toBeTruthy();
});
