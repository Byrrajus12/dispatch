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
    listDocs: () =>
      Promise.resolve({
        docs: [
          {
            id: 'doc-1',
            handle: 'tui-spec',
            title: 'TUI spec',
            status: 'accepted',
            scope: 'team',
          },
          {
            id: 'doc-2',
            handle: 'runbook',
            title: 'Release runbook',
            status: 'draft',
            scope: 'team',
          },
        ],
        total: 2,
      }),
    getDoc: (ref: string) =>
      Promise.resolve({
        doc: {
          id: ref,
          title: ref === 'doc-1' ? 'TUI spec' : 'Release runbook',
        },
        text:
          ref === 'doc-1'
            ? '# TUI spec\n\nRun Dispatch from a terminal.'
            : '# Runbook',
      }),
    listRecentThreads: () =>
      Promise.resolve({
        threads: [
          {
            thread: 'm-t1',
            root: {
              ...runAsk,
              id: 'm-t1',
              thread: 'm-t1',
              body: 'Redis is not provisioned in staging',
            },
            last: {
              ...runAsk,
              id: 'm-t2',
              thread: 'm-t1',
              body: 'Use the shared cluster',
              from: 'human:wyat',
            },
            count: 2,
          },
        ],
      }),
    getThread: () =>
      Promise.resolve({
        messages: [
          {
            ...runAsk,
            id: 'm-t1',
            thread: 'm-t1',
            body: 'Redis is not provisioned in staging',
          },
          {
            ...runAsk,
            id: 'm-t2',
            thread: 'm-t1',
            body: 'Use the shared cluster',
            from: 'human:wyat',
          },
        ],
        deliveries: [],
      }),
    fetchRepoPrs: () =>
      Promise.resolve([
        {
          number: 42,
          title: 'Add address autocomplete',
          author: 'agent',
          isDraft: false,
          updatedAt: '2026-10-12T09:00:00Z',
          headRefName: 'dispatch/r-1',
          baseRefName: 'main',
          url: 'u',
        },
      ]),
    fetchRepoPrDetail: () =>
      Promise.resolve({
        status: {
          number: 42,
          title: 'Add address autocomplete',
          state: 'OPEN',
          isDraft: false,
          reviewDecision: 'REVIEW_REQUIRED',
          mergeable: 'MERGEABLE',
          checks: { passed: 3, failed: 0, pending: 1, total: 4, runs: [] },
        },
        conversation: [
          {
            kind: 'comment',
            author: 'ana',
            body: 'Looks right to me',
            createdAt: '2026-10-12T09:05:00Z',
          },
        ],
      }),
    fetchRepoPrDiff: () =>
      Promise.resolve({
        patch: 'diff --git a/x b/x\n+autocomplete()',
        files: [],
      }),
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

test('keys that arrive together still respect the composer: i then y types, never approves', async () => {
  const { client, replies } = fakeClient();
  const { t, frame, quit } = await mount(120, 40, client);
  await frame();
  t.mockInput.pressKey('j');
  await frame();
  // Same tick, as when a slow link delivers several keys in one read.
  t.mockInput.pressKey('i');
  t.mockInput.pressKey('y');
  t.mockInput.pressKey('q');
  await frame();
  expect(replies).toEqual([]);
  expect(quit).toEqual([]);
});

test('enter on the emptied composer does not send the last message again', async () => {
  const { client, sent } = fakeClient();
  const { t, frame, press } = await mount(120, 40, client);
  await frame();
  await press('i');
  await t.mockInput.typeText('add a test');
  t.mockInput.pressEnter();
  await frame();
  t.mockInput.pressEnter();
  await frame();
  expect(sent.map((m) => m.text)).toEqual(['add a test']);
});

test('alt chords are not plain keys: alt+q does not quit', async () => {
  const { frame, quit, t } = await mount(120, 40, fakeClient().client);
  await frame();
  t.mockInput.pressKey('q', { meta: true });
  await frame();
  expect(quit).toEqual([]);
});

test('control sequences in daemon text never reach the terminal', async () => {
  const hostile = {
    ...record,
    messages: [
      {
        role: 'assistant',
        text: 'safe \x1b]0;pwned\x07text\x1b[2J done',
        at: '2026-10-12T09:00:05Z',
      },
    ],
  } as OverseerRecord;
  const { client } = fakeClient({
    currentOverseer: () => Promise.resolve({ conversation: hostile }),
    getOverseer: () => Promise.resolve(hostile),
    fetchRuns: () =>
      Promise.resolve([
        { ...runs[0], taskTitle: 'evil \x1b]52;c;ZXZpbA==\x07title' },
      ]),
  });
  const { frame } = await mount(120, 40, client);
  const f = await frame();
  expect(f).toContain('safe text done');
  expect(f).toContain('evil title');
  expect(f).not.toContain('pwned');
  expect(f).not.toContain('ZXZpbA');
});

test('4 opens Docs with the selected doc beside the list', async () => {
  const { frame, press } = await mount(120, 40, fakeClient().client);
  await frame();
  const f = await press('4');
  expect(f).toContain('Release runbook');
  expect(f).toContain('Run Dispatch from a terminal.');
});

test('5 opens Threads with the selected thread', async () => {
  const { frame, press } = await mount(120, 40, fakeClient().client);
  await frame();
  const f = await press('5');
  expect(f).toContain('Redis is not provisioned in staging');
  expect(f).toContain('Use the shared cluster');
});

test('6 opens pull requests with checks and conversation; d shows the diff', async () => {
  const { frame, press } = await mount(120, 40, fakeClient().client);
  await frame();
  const f = await press('6');
  expect(f).toContain('#42');
  expect(f).toContain('3/4 checks');
  expect(f).toContain('Looks right to me');
  expect(await press('d')).toContain('autocomplete()');
});

test('ctrl+p lists running projects and enter switches to one, read-only', async () => {
  const other = fakeClient({ fetchTasks: () => Promise.resolve([]) });
  const t = await testRender(
    <TuiRoot
      client={fakeClient().client}
      port={PORT}
      root="/repo/storefront"
      storage={memoryStorage()}
      canDecide
      projects={() => [
        {
          name: 'billing',
          root: '/repo/billing',
          port: 5001,
          agentToken: 'tb',
        },
        {
          name: 'storefront',
          root: '/repo/storefront',
          port: PORT,
          agentToken: 'ts',
        },
      ]}
      clientFor={() => other.client}
      onQuit={() => {}}
    />,
    { width: 120, height: 40 }
  );
  destroy = () => t.renderer.destroy();
  const frame = async () => {
    for (let i = 0; i < 5; i++) {
      await settle();
      await t.renderOnce();
    }
    return t.captureCharFrame();
  };
  await frame();
  t.mockInput.pressKey('p', { ctrl: true });
  const picker = await frame();
  expect(picker).toContain('billing');
  t.mockInput.pressKey('RETURN');
  const switched = await frame();
  expect(switched).toContain('dispatch · billing');
  expect(switched).toContain('read-only');
});

test('control sequences in PR comments, docs and threads never reach the terminal', async () => {
  const { client } = fakeClient({
    fetchRepoPrDetail: () =>
      Promise.resolve({
        status: {
          number: 42,
          title: 'pr\x1b]0;owned\x07title',
          state: 'OPEN',
          isDraft: false,
          reviewDecision: null,
          mergeable: 'MERGEABLE',
          checks: { passed: 1, failed: 0, pending: 0, total: 1, runs: [] },
        },
        conversation: [
          {
            kind: 'comment',
            author: 'x\x1b[2J',
            body: 'hi\x1b]52;c;ZXZpbA==\x07there',
            createdAt: '',
          },
        ],
      }),
    getDoc: () =>
      Promise.resolve({ doc: {}, text: 'doc\x1b]0;docpwn\x07body' }),
    getThread: () =>
      Promise.resolve({
        messages: [{ ...runAsk, id: 'm-t1', body: 'msg\x1b]0;thrpwn\x07body' }],
        deliveries: [],
      }),
  });
  const { frame, press } = await mount(120, 40, client);
  await frame();
  const prs = await press('6');
  expect(prs).toContain('hithere');
  expect(prs).toContain('prtitle');
  expect(prs).not.toContain('ZXZpbA');
  expect(prs).not.toContain('owned');
  const docs = await press('4');
  expect(docs).toContain('docbody');
  expect(docs).not.toContain('docpwn');
  const threads = await press('5');
  expect(threads).toContain('msgbody');
  expect(threads).not.toContain('thrpwn');
});
