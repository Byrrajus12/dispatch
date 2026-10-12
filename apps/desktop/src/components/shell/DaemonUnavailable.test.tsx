import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { DaemonUnavailable } from './DaemonUnavailable';

test('error state speaks plainly and tucks the raw detail behind Details', () => {
  render(
    <DaemonUnavailable
      starting={false}
      errorDetail="spawn failed: ENOENT /x/dispatchd"
      onRetry={() => {}}
    />
  );
  expect(
    screen.getByText('Dispatch couldn’t start for this project')
  ).toBeTruthy();
  expect(screen.getByText('Details')).toBeTruthy();
  expect(screen.getByText('Retry')).toBeTruthy();
});

test('starting state does not mention the daemon', () => {
  const { container } = render(
    <DaemonUnavailable starting errorDetail={null} onRetry={() => {}} />
  );
  expect(container.textContent).not.toMatch(/dispatchd|daemon/i);
});
