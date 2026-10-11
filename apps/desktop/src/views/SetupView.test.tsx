import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, mock, test } from 'bun:test';
import type { ReactElement } from 'react';

const tauri = {
  gitSetupStatus: mock(() =>
    Promise.resolve({
      installed: true,
      version: 'git version 2',
      name: 'Ada',
      email: 'a@b.c',
      installHint: null,
    })
  ),
  installGit: mock(() => Promise.resolve()),
  setGitIdentity: mock(() => Promise.resolve()),
  pickDirectory: mock(() => Promise.resolve('/Users/ada/site')),
  projectFolderState: mock(() =>
    Promise.resolve({
      isDir: true,
      isGitRepo: false,
      hasCommits: false,
      hasGitignore: false,
    })
  ),
  prepareProjectFolder: mock(() => Promise.resolve()),
};
// bun replaces the whole module, so stub every export AddProjectDialog's import graph uses.
void mock.module('../lib/tauri', () => ({
  ...tauri,
  listGithubRepos: mock(() => Promise.resolve([])),
  cloneGithubRepo: mock(() => Promise.resolve('')),
}));

const { SetupView } = await import('./SetupView');

// GitStep reads and invalidates react-query, so every render needs a fresh client.
function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>
  );
}

beforeEach(() => {
  for (const fn of Object.values(tauri)) fn.mockClear();
});

test('shows a tick for installed git with identity', async () => {
  render(
    <SetupView projectPath={null} onProjectChosen={() => Promise.resolve()} />
  );
  expect(
    await screen.findByText('Git is installed and knows who you are.')
  ).toBeTruthy();
});

test('asks for a name and email when git has none, and saves them', async () => {
  tauri.gitSetupStatus.mockImplementationOnce(() =>
    Promise.resolve({
      installed: true,
      version: 'v',
      name: null,
      email: null,
      installHint: null,
    })
  );
  render(
    <SetupView projectPath={null} onProjectChosen={() => Promise.resolve()} />
  );
  fireEvent.change(await screen.findByLabelText('Your name'), {
    target: { value: 'Ada' },
  });
  fireEvent.change(screen.getByLabelText('Your email'), {
    target: { value: 'ada@example.com' },
  });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() =>
    expect(tauri.setGitIdentity).toHaveBeenCalledWith('Ada', 'ada@example.com')
  );
});

test('offers to install git when it is missing', async () => {
  tauri.gitSetupStatus.mockImplementationOnce(() =>
    Promise.resolve({
      installed: false,
      version: null,
      name: null,
      email: null,
      installHint: null,
    })
  );
  render(
    <SetupView projectPath={null} onProjectChosen={() => Promise.resolve()} />
  );
  fireEvent.click(await screen.findByText('Install Git'));
  await waitFor(() => expect(tauri.installGit).toHaveBeenCalled());
});

test('turns on version tracking for a plain folder before adding it', async () => {
  const onProjectChosen = mock(() => Promise.resolve());
  render(<SetupView projectPath={null} onProjectChosen={onProjectChosen} />);
  fireEvent.click(await screen.findByText('Choose a folder'));
  fireEvent.click(await screen.findByText('Turn on version tracking'));
  await waitFor(() =>
    expect(tauri.prepareProjectFolder).toHaveBeenCalledWith('/Users/ada/site')
  );
  await waitFor(() =>
    expect(onProjectChosen).toHaveBeenCalledWith('/Users/ada/site')
  );
});

test('adds a folder that is already a repo with history straight away', async () => {
  tauri.projectFolderState.mockImplementationOnce(() =>
    Promise.resolve({
      isDir: true,
      isGitRepo: true,
      hasCommits: true,
      hasGitignore: true,
    })
  );
  const onProjectChosen = mock(() => Promise.resolve());
  render(<SetupView projectPath={null} onProjectChosen={onProjectChosen} />);
  fireEvent.click(await screen.findByText('Choose a folder'));
  await waitFor(() =>
    expect(onProjectChosen).toHaveBeenCalledWith('/Users/ada/site')
  );
  expect(tauri.prepareProjectFolder).not.toHaveBeenCalled();
});

test('never shows internal words', async () => {
  const { container } = render(
    <SetupView projectPath={null} onProjectChosen={() => Promise.resolve()} />
  );
  await screen.findByText('Git is installed and knows who you are.');
  expect(container.textContent).not.toMatch(
    /dispatchd|\.dispatch\/|tracker|worktree|executor/i
  );
});
