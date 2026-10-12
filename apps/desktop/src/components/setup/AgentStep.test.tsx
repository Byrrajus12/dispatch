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
        port={4771}
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
  const base = report();
  const ready = report({
    steps: [{ id: 'agent', status: 'ok', message: 'Codex is ready.' }],
    defaultProvider: 'codex',
    providers: [
      {
        ...base.providers[1],
        installed: true,
        works: true,
        ready: true,
        auth: 'signed-in',
      },
    ],
  });
  const { onSetDefault, onContinue } = setup(ready);
  await click(await screen.findByText('Continue'));
  await waitFor(() => expect(onSetDefault).toHaveBeenCalledWith('codex'));
  await waitFor(() => expect(onContinue).toHaveBeenCalled());
});

test('re-reads installed agents before saving the default', async () => {
  const base = report();
  const ready = report({
    steps: [{ id: 'agent', status: 'ok', message: 'Codex is ready.' }],
    defaultProvider: 'codex',
    providers: [
      {
        ...base.providers[1],
        installed: true,
        works: true,
        ready: true,
        auth: 'signed-in',
      },
    ],
  });
  const order: string[] = [];
  const { client, onSetDefault } = setup(ready);
  client.refreshSetup.mockImplementation(() => {
    order.push('refresh');
    return Promise.resolve({ added: [] });
  });
  onSetDefault.mockImplementation((id: string) => {
    order.push(`default:${id}`);
    return Promise.resolve();
  });
  await click(await screen.findByText('Continue'));
  await waitFor(() => expect(order).toEqual(['refresh', 'default:codex']));
});

const usingKey = () => {
  const r = report();
  r.providers[0] = {
    ...r.providers[0],
    usingApiKey: true,
    ready: true,
  };
  return r;
};

test('a saved key can be replaced', async () => {
  const { client } = setup(usingKey());
  expect(
    await screen.findByText(
      'Using an API key instead of your Claude Code sign-in.'
    )
  ).toBeTruthy();
  expect(screen.queryByText('Use an API key instead')).toBeNull();
  await click(screen.getByText('Replace key'));
  fireEvent.change(screen.getByLabelText('Claude Code API key'), {
    target: { value: 'sk-ant-2' },
  });
  await click(screen.getByText('Save key'));
  await waitFor(() =>
    expect(client.saveAgentKey).toHaveBeenCalledWith('claude', 'sk-ant-2')
  );
});

test('a saved key can be removed', async () => {
  const { client } = setup(usingKey());
  await click(await screen.findByText('Remove key'));
  await waitFor(() =>
    expect(client.saveAgentKey).toHaveBeenCalledWith('claude', null)
  );
});

test('never shows internal words', async () => {
  setup();
  await screen.findByText("Claude Code isn't signed in.");
  expect(document.body.textContent).not.toMatch(
    /dispatchd|\.dispatch\/|tracker|worktree|executor/i
  );
});

test('continue follows the selected agent, not the default', async () => {
  const signedOutDefault = report({
    defaultProvider: 'codex',
    steps: [{ id: 'agent', status: 'ok', message: 'Codex is ready.' }],
    providers: [
      {
        ...report().providers[0],
        id: 'codex',
        name: 'Codex',
        ready: true,
        auth: 'signed-in',
      },
      report().providers[0],
    ],
  });
  setup(signedOutDefault);
  const button = (await screen.findByText('Continue')).closest('button');
  expect(button?.disabled).toBe(false);
  await click(screen.getByLabelText('Use Claude Code'));
  await waitFor(() => expect(button?.disabled).toBe(true));
});

test('continue is enabled for a ready selection even when the default needs action', async () => {
  const mixed = report();
  mixed.providers[1] = {
    ...mixed.providers[1],
    installed: true,
    works: true,
    ready: true,
    auth: 'signed-in',
  };
  setup(mixed);
  const button = (await screen.findByText('Continue')).closest('button');
  expect(button?.disabled).toBe(true);
  await click(screen.getByLabelText('Use Codex'));
  await waitFor(() => expect(button?.disabled).toBe(false));
});

test('re-checks the machine after an install command exits', async () => {
  const { client } = setup();
  client.fetchTerminal.mockImplementation(() =>
    Promise.resolve({ id: 't1', state: 'exited', pty: true, exitCode: 0 })
  );
  await click(await screen.findByText('Install Codex'));
  await waitFor(() => expect(client.refreshSetup).toHaveBeenCalled());
  await waitFor(() =>
    expect(client.fetchSetup.mock.calls.length).toBeGreaterThan(1)
  );
});
