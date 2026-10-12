import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { TasksExtraGroups } from './TasksExtraGroups';

// Only what the groups read; no daemon, so the docs group stays hidden.
const data = {
  inbox: [],
  runs: [],
  repoPrs: [],
  client: null,
  port: undefined,
  messageAccess: { canMessage: false },
} as unknown as DispatchProjectData;

test('the Notes group has no door to a Notes page: notes live in Coming in', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TasksExtraGroups
        data={data}
        onOpenPr={() => {}}
        onOpenDoc={() => {}}
        onOpenAllDocs={() => {}}
      />
    </QueryClientProvider>
  );
  expect(screen.queryByRole('button', { name: 'All notes →' })).toBeNull();
});
