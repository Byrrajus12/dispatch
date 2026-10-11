import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
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
  // The mock registry is shared across test files, so AgentStep.test's import needs this.
  openUrl: mock(() => Promise.resolve()),
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

// Clicks inside an awaited act so the async state updates a click triggers are flushed.
async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// Lets in-flight state updates land inside act before the next test starts.
afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  cleanup();
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
  await click(screen.getByText('Save'));
  await waitFor(() =>
    expect(tauri.setGitIdentity).toHaveBeenCalledWith('Ada', 'ada@example.com')
  );
  await screen.findByText('Git is installed and knows who you are.');
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
  await click(await screen.findByText('Install Git'));
  await waitFor(() => expect(tauri.installGit).toHaveBeenCalled());
});

test('shows a plain sentence, with the raw reason under Details, when saving the name fails', async () => {
  tauri.gitSetupStatus.mockImplementationOnce(() =>
    Promise.resolve({
      installed: true,
      version: 'v',
      name: null,
      email: null,
      installHint: null,
    })
  );
  tauri.setGitIdentity.mockImplementationOnce(() =>
    Promise.reject('fatal: boom')
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
  await click(screen.getByText('Save'));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe(
    "Couldn't save that. Check your name and email and try again."
  );
  expect(screen.getByText('Details')).toBeTruthy();
});

test('shows the reason under Details when the folder cannot be checked', async () => {
  tauri.projectFolderState.mockImplementationOnce(() =>
    Promise.reject('permission denied')
  );
  render(
    <SetupView projectPath={null} onProjectChosen={() => Promise.resolve()} />
  );
  await click(await screen.findByText('Choose a folder'));
  expect(await screen.findByText('Details')).toBeTruthy();
  expect(screen.getByText('Set up this folder')).toBeTruthy();
});

test('turns on version tracking for a plain folder before adding it', async () => {
  const onProjectChosen = mock(() => Promise.resolve());
  render(<SetupView projectPath={null} onProjectChosen={onProjectChosen} />);
  await click(await screen.findByText('Choose a folder'));
  await click(await screen.findByText('Turn on version tracking'));
  await waitFor(() =>
    expect(tauri.prepareProjectFolder).toHaveBeenCalledWith('/Users/ada/site')
  );
  await waitFor(() =>
    expect(onProjectChosen).toHaveBeenCalledWith('/Users/ada/site')
  );
  await waitFor(() => expect(onProjectChosen).toHaveBeenCalledTimes(1));
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
  await click(await screen.findByText('Choose a folder'));
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
