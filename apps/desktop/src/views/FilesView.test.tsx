import { render, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { FilesView } from './FilesView';

// Only what FilesView and its tree read; every fetch is recorded.
function fakeData(fetched: string[]): DispatchProjectData {
  return {
    client: {
      fetchWorkspaceTree: () => Promise.resolve({ entries: [] }),
      fetchWorkspaceFile: (path: string) => {
        fetched.push(path);
        return Promise.resolve({ path, kind: 'text', text: 'x' });
      },
    },
    portLoading: false,
    portErrorDetail: null,
    retryEnsureDispatchd: () => {},
  } as unknown as DispatchProjectData;
}

test('opens on initialPath, as a file link in a thread asks', async () => {
  const fetched: string[] = [];
  render(<FilesView data={fakeData(fetched)} initialPath="src/a.ts" />);
  await waitFor(() => expect(fetched).toEqual(['src/a.ts']));
});

test('opens nothing without an initialPath', async () => {
  const fetched: string[] = [];
  render(<FilesView data={fakeData(fetched)} />);
  await new Promise((r) => setTimeout(r, 20));
  expect(fetched).toEqual([]);
});
