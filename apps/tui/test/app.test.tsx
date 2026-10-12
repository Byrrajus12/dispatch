import type { TaskDoc } from '@dispatch-foo/core/browser';
import type {
  ApiClient,
  Message,
  OverseerRecord,
  ReplyInput,
  RunMeta,
} from '@dispatch/client';
import { memoryStorage } from '@dispatch/client';
import { testRender } from '@opentui/react/test-utils';
import { afterEach, expect, test } from 'bun:test';

import { TuiRoot } from '../src/App';

const PORT = 4777;

const record: OverseerRecord = {
  id: 'w-1',
  prompt: 'rate limit the webhook',
  backendName: 'fake',
  state: 'ready',
  messages: [
    {
      role: 'user',
      text: 'rate limit the webhook',
      at: '2026-10-12T09:00:00Z',
    },
    {
      role: 'assistant',
      text: 'That spans three tasks, so here is a plan.',
      at: '2026-10-12T09:00:05Z',
    },
  ],
  pendingActions: [
    {
      id: 'act-1',
      tool: 'create_plan',
      input: {},
      summary: 'Create the plan: Webhook rate limiting (3 tasks)',
      createdAt: '2026-10-12T09:00:06Z',
      status: 'pending',
    },
  ],
  pendingApprovals: [],
  undeliveredDecisions: [],
  createdAt: '2026-10-12T09:00:00Z',
  updatedAt: '2026-10-12T09:00:06Z',
} as OverseerRecord;

const actionGate = {
  id: 'g-act',
  thread: 'g-act',
  replyTo: null,
  from: 'agent:dispatch',
  to: ['human:wyat'],
  kind: 'question',
  body: 'Create the plan?',
  refs: [],
  urgent: false,
  blocking: true,
  wake: 'none',
  createdAt: '2026-10-12T09:00:06Z',
  choices: ['confirm', 'cancel'],
  data: { type: 'overseer-action', conversation: 'w-1', actionId: 'act-1' },
} as unknown as Message;

const runAsk = {
  ...actionGate,
  id: 'm-ask',
  from: 'run:r-1',
  body: 'Which geocoding provider?',
  choices: ['Google', 'Mapbox'],
  data: undefined,
} as unknown as Message;

const runs = [
  {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Add address autocomplete',
    state: 'running',
    updatedAt: '2026-10-12T09:01:00Z',
  },
] as RunMeta[];

const tasks = [
  {
    meta: {
      id: 't-1',
      title: 'Add address autocomplete',
      status: 'working',
      priority: 'high',
    },
    body: '## Description\n\nAutocomplete addresses at checkout.',
  },
  {
    meta: {
      id: 't-2',
      title: 'Cache the search index',
      status: 'ready',
      priority: 'medium',
    },
    body: '',
  },
] as unknown as TaskDoc[];

function fakeClient(over: Partial<Record<keyof ApiClient, unknown>> = {}) {
  const replies: { id: string; input: ReplyInput }[] = [];
  const sent: { id: string; text: string }[] = [];
  const client = {
    baseUrl: `http://127.0.0.1:${PORT}`,
    fetchTasks: () => Promise.resolve(tasks),
    fetchRuns: () => Promise.resolve(runs),
    fetchInbox: () => Promise.resolve([]),
    fetchRunDiff: () =>
      Promise.resolve({
        patch:
          'diff --git a/src/geo.ts b/src/geo.ts\n+export const provider = "mapbox";',
        files: [{ path: 'src/geo.ts', status: 'M' }],
      }),
    openDecisions: () => Promise.resolve({ items: [actionGate, runAsk] }),
    currentOverseer: () => Promise.resolve({ conversation: record }),
    getOverseer: () => Promise.resolve(record),
    replyToMessage: (id: string, input: ReplyInput) => {
      replies.push({ id, input });
      return Promise.resolve({ ok: true });
    },
    sendOverseerMessage: (id: string, text: string) => {
      sent.push({ id, text });
      return Promise.resolve(record);
    },
    connectEvents: () => () => {},
    ...over,
  } as unknown as ApiClient;
  return { client, replies, sent };
}

let destroy: (() => void) | null = null;
afterEach(() => {
  destroy?.();
  destroy = null;
});

const settle = () => new Promise((r) => setTimeout(r, 30));

async function mount(
  width: number,
  height: number,
  client: ApiClient,
  canDecide = true
) {
  const quit: string[] = [];
  const t = await testRender(
    <TuiRoot
      client={client}
      port={PORT}
      root="/repo/storefront"
      storage={memoryStorage()}
      canDecide={canDecide}
      onQuit={() => quit.push('quit')}
    />,
    { width, height }
  );
  destroy = () => t.renderer.destroy();
  const frame = async () => {
    for (let i = 0; i < 5; i++) {
      await settle();
      await t.renderOnce();
    }
    return t.captureCharFrame();
  };
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      t.mockInput.pressKey(k);
      await settle();
    }
    return frame();
  };
  return { t, frame, press, quit };
}

test('a wide terminal shows Coming in, the conversation with its card, and Going out', async () => {
  const { frame } = await mount(120, 40, fakeClient().client);
  const f = await frame();
  expect(f).toContain('Coming in');
  expect(f).toContain('Which geocoding provider?');
  expect(f).toContain('That spans three tasks');
  expect(f).toContain('Create the plan: Webhook rate limiting');
  expect(f).toContain('Going out');
  expect(f).toContain('Add address autocomplete');
  expect(f).not.toContain('Create the plan?');
});

test('a narrow terminal drops the side columns and counts them in the header', async () => {
  const { frame } = await mount(80, 24, fakeClient().client);
  const f = await frame();
  expect(f).not.toContain('Going out');
  expect(f).toContain('in 1');
  expect(f).toContain('out 1');
  expect(f).toContain('That spans three tasks');
});

test('j focuses the card and y approves it through its gate', async () => {
  const { client, replies } = fakeClient();
  const { frame, press } = await mount(120, 40, client);
  await frame();
  await press('j', 'y');
  expect(replies).toEqual([
    { id: 'g-act', input: { body: '', choice: 'confirm' } },
  ]);
});

test('typing y or q into the composer types it, and never approves or quits', async () => {
  const { client, replies } = fakeClient();
  const { frame, press, quit } = await mount(120, 40, client);
  await frame();
  const f = await press('j', 'i', 'y', 'q');
  expect(replies).toEqual([]);
  expect(quit).toEqual([]);
  expect(f).toContain('yq');
});

test('2 opens Tasks with the selected task beside the list; 3 opens Runs and d its diff', async () => {
  const { frame, press } = await mount(120, 40, fakeClient().client);
  await frame();
  const tasksFrame = await press('2');
  expect(tasksFrame).toContain('Cache the search index');
  expect(tasksFrame).toContain('Autocomplete addresses at checkout.');
  const runsFrame = await press('3');
  expect(runsFrame).toContain('r-1');
  const diffFrame = await press('d');
  expect(diffFrame).toContain('export const provider');
});

test('an unreachable daemon is reported in the status line and the app keeps running', async () => {
  const { client } = fakeClient({
    fetchRuns: () => Promise.reject(new Error('connect ECONNREFUSED')),
    fetchTasks: () => Promise.reject(new Error('connect ECONNREFUSED')),
  });
  const { frame, press } = await mount(120, 40, client);
  // One retry, half a second apart, before a query reports failure.
  await new Promise((r) => setTimeout(r, 900));
  const f = await frame();
  expect(f).toContain('ECONNREFUSED');
  expect(await press('2')).toContain('Tasks');
});

test('q quits outside the composer', async () => {
  const { frame, press, quit } = await mount(120, 40, fakeClient().client);
  await frame();
  await press('q');
  expect(quit).toEqual(['quit']);
});

test('i, typing and enter send the message to the open conversation', async () => {
  const { client, sent } = fakeClient();
  const { t, frame, press } = await mount(120, 40, client);
  await frame();
  await press('i');
  await t.mockInput.typeText('add a test');
  t.mockInput.pressEnter();
  await frame();
  expect(sent.map((m) => m.text)).toEqual(['add a test']);
});

test('with the fake backend on, a new conversation asks dispatchd for it', async () => {
  const started: { backend?: string }[] = [];
  const { client } = fakeClient({
    currentOverseer: () => Promise.resolve({ conversation: null }),
    startOverseer: (_prompt: string, opts: { backend?: string }) => {
      started.push(opts);
      return Promise.resolve(record);
    },
  });
  const t = await testRender(
    <TuiRoot
      client={client}
      port={PORT}
      root="/repo/storefront"
      storage={memoryStorage()}
      canDecide
      fakeBackend
      onQuit={() => {}}
    />,
    { width: 120, height: 40 }
  );
  destroy = () => t.renderer.destroy();
  await settle();
  t.mockInput.pressKey('i');
  await settle();
  await t.mockInput.typeText('hello');
  t.mockInput.pressEnter();
  for (let i = 0; i < 5; i++) {
    await settle();
    await t.renderOnce();
  }
  expect(started[0]?.backend).toBe('fake');
});

test('without the app token it opens read-only, says how to get one, and never asks for decisions', async () => {
  let decisionsAsked = 0;
  let overseerAsked = 0;
  const { client } = fakeClient({
    openDecisions: () => {
      decisionsAsked++;
      return Promise.resolve({ items: [] });
    },
    currentOverseer: () => {
      overseerAsked++;
      return Promise.resolve({ conversation: null });
    },
  });
  const { frame, press } = await mount(120, 40, client, false);
  const f = await frame();
  expect(f).toContain('read-only');
  expect(f).toContain('--ask-token');
  expect(f).toContain('Add address autocomplete');
  const typed = await press('i', 'y');
  expect(typed).not.toContain('type, enter to send');
  expect(decisionsAsked).toBe(0);
  expect(overseerAsked).toBe(0);
});

test('esc leaves the composer, so j and y act on the card again', async () => {
  const { client, replies } = fakeClient();
  const { frame, press } = await mount(120, 40, client);
  await frame();
  await press('i', 'h', 'i');
  await press('ESCAPE');
  // A lone ESC is told apart from an Alt chord only after a short pause.
  await new Promise((r) => setTimeout(r, 200));
  const f = await press('j', 'y');
  expect(replies).toEqual([
    { id: 'g-act', input: { body: '', choice: 'confirm' } },
  ]);
  expect(f).not.toContain('enter send');
});
