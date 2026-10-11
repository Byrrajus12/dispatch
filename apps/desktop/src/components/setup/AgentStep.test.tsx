import type { SetupReport } from '@dispatch-foo/core/browser';
import type { ApiClient } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, mock, test } from 'bun:test';

const openUrl = mock(() => Promise.resolve());
// bun replaces the whole module, so stub the one export AgentStep uses.
void mock.module('../../lib/tauri', () => ({ openUrl }));

const { AgentStep } = await import('./AgentStep');

const caps = { execute: true, plan: false, oversee: false };
function report(over: Partial<SetupReport> = {}): SetupReport {
  return {
    defaultProvider: 'claude',
    steps: [
      {
        id: 'agent',
        status: 'needs-action',
        message: "Claude Code isn't signed in.",
        fix: {
          kind: 'run',
          label: 'Sign in',
          command: ['claude', 'auth', 'login'],
        },
      },
    ],
    providers: [
      {
        id: 'claude',
        name: 'Claude Code',
        blurb: 'Uses your Claude Pro or Max plan.',
        installed: true,
        works: true,
        auth: 'signed-out',
        usingApiKey: false,
        ready: false,
        capabilities: { execute: true, plan: true, oversee: true },
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        signIn: {
          kind: 'run',
          label: 'Sign in',
          command: ['claude', 'auth', 'login'],
        },
      },
      {
        id: 'codex',
        name: 'Codex',
        blurb: 'Uses your ChatGPT plan.',
        installed: false,
        works: false,
        auth: 'unknown',
        usingApiKey: false,
        ready: false,
        capabilities: caps,
        apiKeyEnv: 'OPENAI_API_KEY',
        install: {
          kind: 'run',
          label: 'Install Codex',
          command: ['brew', 'install', '--cask', 'codex'],
        },
      },
      {
        id: 'cursor',
        name: 'Cursor',
        blurb: 'Uses your Cursor account.',
        installed: false,
        works: false,
        auth: 'unknown',
        usingApiKey: false,
        ready: false,
        capabilities: caps,
        install: {
          kind: 'open-url',
          label: 'Get Cursor',
          href: 'https://cursor.com/download',
        },
      },
    ],
    ...over,
  };
}

function setup(r = report()) {
  const client = {
    fetchSetup: mock(() => Promise.resolve(r)),
    saveAgentKey: mock((..._args: unknown[]) =>
      Promise.resolve(
        report({
          steps: [
            { id: 'agent', status: 'ok', message: 'Claude Code is ready.' },
          ],
        })
      )
    ),
    refreshSetup: mock(() => Promise.resolve({ added: [] })),
    createTerminal: mock(() =>
      Promise.resolve({ id: 't1', state: 'running', pty: true })
    ),
    // CommandTerminal's useTerminalOutput polls these.
    fetchTerminal: mock(() =>
      Promise.resolve({ id: 't1', state: 'running', pty: true })
    ),
    fetchTerminalOutput: mock(() =>
      Promise.resolve({
        data: '',
        next: 0,
        more: false,
        state: 'running',
        exitCode: null,
        total: 0,
      })
    ),
    sendTerminalInput: mock(() => Promise.resolve()),
  };
  const onSetDefault = mock((_id: string) => Promise.resolve());
  const onContinue = mock(() => {});
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AgentStep
        client={client as unknown as ApiClient}
        onSetDefault={onSetDefault}
        onContinue={onContinue}
      />
    </QueryClientProvider>
  );
  return { client, onSetDefault, onContinue };
}

// Clicks inside an awaited act so the async state updates a click triggers are flushed.
async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  cleanup();
});

test('lists providers with the default first and offers sign-in', async () => {
  setup();
  expect(await screen.findByText("Claude Code isn't signed in.")).toBeTruthy();
  expect(screen.getByText('Sign in')).toBeTruthy();
  expect(screen.getByText('Install Codex')).toBeTruthy();
});

test('sign-in opens the provider login in a terminal', async () => {
  const { client } = setup();
  await click(await screen.findByText('Sign in'));
  await waitFor(() =>
    expect(client.createTerminal).toHaveBeenCalledWith({
      command: ['claude', 'auth', 'login'],
      title: 'Sign in to Claude Code',
    })
  );
});

test('a download link opens in the browser instead of a terminal', async () => {
  const { client } = setup();
  await click(await screen.findByText('Get Cursor'));
  expect(openUrl).toHaveBeenCalledWith('https://cursor.com/download');
  expect(client.createTerminal).not.toHaveBeenCalled();
});

test('saves an API key instead', async () => {
  const { client } = setup();
  await click(await screen.findByText('Use an API key instead'));
  fireEvent.change(screen.getByLabelText('Claude Code API key'), {
    target: { value: 'sk-ant-1' },
  });
  await click(screen.getByText('Save key'));
  await waitFor(() =>
    expect(client.saveAgentKey).toHaveBeenCalledWith('claude', 'sk-ant-1')
  );
  expect(document.body.textContent).not.toContain('sk-ant-1');
});

test('a failed key save shows a sentence with the reason under Details', async () => {
  const { client } = setup();
  client.saveAgentKey.mockImplementationOnce(() =>
    Promise.reject('disk is full')
  );
  await click(await screen.findByText('Use an API key instead'));
  fireEvent.change(screen.getByLabelText('Claude Code API key'), {
    target: { value: 'sk-ant-1' },
  });
  await click(screen.getByText('Save key'));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe(
    "Couldn't save that key. Check it and try again."
  );
  expect(screen.getByText('Details')).toBeTruthy();
  expect(document.body.textContent).not.toContain('sk-ant-1');
});

test('continue is disabled until the agent step is ok or unknown', async () => {
  setup();
  const button = (await screen.findByText('Continue')).closest('button');
  expect(button?.disabled).toBe(true);
});

test('continue is enabled for a ready agent and makes it the default', async () => {
  const ready = report({
    steps: [{ id: 'agent', status: 'ok', message: 'Codex is ready.' }],
    defaultProvider: 'codex',
  });
  const { onSetDefault, onContinue } = setup(ready);
  await click(await screen.findByText('Continue'));
  await waitFor(() => expect(onSetDefault).toHaveBeenCalledWith('codex'));
  await waitFor(() => expect(onContinue).toHaveBeenCalled());
});

test('never shows internal words', async () => {
  setup();
  await screen.findByText("Claude Code isn't signed in.");
  expect(document.body.textContent).not.toMatch(
    /dispatchd|\.dispatch\/|tracker|worktree|executor/i
  );
});
