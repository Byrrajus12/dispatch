import {
  type ApiClient,
  createApiClient,
  type KeyValueStore,
  useOverseerSession,
} from '@dispatch/client';
import type { KeyEvent } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';

import { CrashGuard } from './CrashGuard';
import {
  useDaemonData,
  useDaemonEvents,
  useDocs,
  usePrs,
  useThreads,
} from './data';
import { comingIn, goingOut } from './lists';
import {
  initialNav,
  type Key,
  type NavContext,
  navReducer,
  type NavState,
  resolveKey,
} from './nav';
import type { Project } from './projects';
import { color } from './theme';
import { DocsView } from './views/Docs';
import { Header } from './views/Header';
import { Help } from './views/Help';
import { OverseerView } from './views/Overseer';
import { ProjectsOverlay } from './views/Projects';
import { PrsView } from './views/Prs';
import { RunsView } from './views/Runs';
import { StatusLine } from './views/StatusLine';
import { TasksView } from './views/Tasks';
import { ThreadsView } from './views/Threads';

export interface TuiProps {
  client: ApiClient;
  port: number;
  root: string;
  storage: KeyValueStore;
  /** Holding the app token (human tier): the Overseer and approvals work. */
  canDecide: boolean;
  /** Opens new conversations on dispatchd's scripted fake backend (dev and demos). */
  fakeBackend?: boolean;
  /** Projects with a running dispatchd, re-read each time the picker opens. */
  projects?: () => Project[];
  /** A client for another project's daemon; defaults to its agent token, so read-only. */
  clientFor?: (project: Project) => ApiClient;
  onQuit: () => void;
}

interface AppProps extends TuiProps {
  onPickProject: (project: Project) => void;
}

const WIDE = 120;

// A printable key is named by what it types (so `?`, `/` and `[` match); the rest keep OpenTUI's name.
function toKey(event: KeyEvent): Key {
  const printable =
    !event.ctrl &&
    event.sequence.length === 1 &&
    event.sequence >= ' ' &&
    event.sequence !== '\x7f';
  // Alt sends ESC + key; name it apart so alt+q or alt+y never act as q or y.
  if (event.meta || event.option) {
    return { name: `alt+${event.name}`, ctrl: event.ctrl, shift: event.shift };
  }
  return {
    name: printable ? event.sequence : event.name,
    ctrl: event.ctrl,
    shift: event.shift,
  };
}

/** The TUI shell: header, the current view, the status line, and one keyboard handler. */
function App({
  client,
  port,
  root,
  storage,
  canDecide,
  fakeBackend = false,
  projects: listAll = () => [],
  onPickProject,
  onQuit,
}: AppProps) {
  const options = useMemo(
    () => ({ storage, fakeBackend: () => fakeBackend }),
    [storage, fakeBackend]
  );
  // Without the app token the Overseer is out of reach, so the session gets no client at all.
  const session = useOverseerSession(
    canDecide ? client : null,
    port,
    root,
    undefined,
    undefined,
    true,
    options
  );
  const data = useDaemonData(client, port, canDecide);
  useDaemonEvents(client, port);
  const { width } = useTerminalDimensions();
  const wide = width >= WIDE;

  const [nav, setNav] = useState<NavState>(initialNav);
  const [composerKey, setComposerKey] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  // Same query keys as the views, so these only read the counts the keymap needs.
  const docs = useDocs(client, port, null).docs;
  const threads = useThreads(client, port, canDecide, null).threads;
  const prs = usePrs(client, port, null, false).prs;

  const inflow = comingIn(data.asks, data.inbox);
  const outflow = goingOut(data.runs);
  const cards = (session.record?.pendingActions ?? []).filter(
    (a) => a.status === 'pending'
  );
  const listLength = {
    overseer: 0,
    tasks: data.tasks.length,
    runs: data.runs.length,
    docs: docs.length,
    threads: threads.length,
    prs: prs.length,
  }[nav.view];
  const ctx: NavContext = {
    wide,
    cards: cards.length,
    canCompose: canDecide,
    lengths: {
      in: inflow.length,
      out: outflow.length,
      list: listLength,
      projects: projects.length,
    },
  };

  // The keyboard handler reads the latest render through refs, never a stale closure.
  const latest = useRef({ nav, ctx, cards, session, projects });
  latest.current = { nav, ctx, cards, session, projects };

  useKeyboard((event) => {
    const { nav: now, ctx: c, cards: pending, session: s } = latest.current;
    const action = resolveKey(now, toKey(event), c);
    if (action === null) return;
    if (action.type === 'quit') {
      onQuit();
      return;
    }
    if (action.type === 'decide') {
      const card = pending[action.card];
      if (card !== undefined) void s.confirmAction(card.id, action.approve);
      return;
    }
    if (action.type === 'pick-project') {
      const picked = latest.current.projects[action.index];
      if (picked !== undefined && picked.root !== root) {
        onPickProject(picked);
        return;
      }
    }
    if (action.type === 'overlay' && action.which === 'projects') {
      const found = listAll();
      setProjects(found);
      latest.current.ctx.lengths.projects = found.length;
    }
    // Keys from one stdin read arrive before React re-renders: record the next state
    // now, so a `y` right behind an `i` is already seen as typing.
    const next =
      action.type === 'pick-project'
        ? { ...now, overlay: null }
        : navReducer(now, action, latest.current.ctx);
    latest.current = { ...latest.current, nav: next };
    setNav(next);
  });

  const submit = (text: string) => {
    if (text.trim() === '') return;
    void session.submit(text);
    setComposerKey((k) => k + 1);
  };

  const project = root.split('/').filter(Boolean).at(-1) ?? root;
  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor="transparent"
    >
      <Header
        project={project}
        view={nav.view}
        wide={wide}
        counts={
          nav.view === 'overseer' && !wide
            ? { in: inflow.length, out: outflow.length }
            : null
        }
      />
      <box flexGrow={1} flexDirection="column">
        {nav.overlay === 'help' ? (
          <Help />
        ) : nav.overlay === 'projects' ? (
          <ProjectsOverlay
            projects={projects}
            current={root}
            cursor={nav.cursor.projects}
          />
        ) : nav.view === 'overseer' ? (
          <OverseerView
            session={session}
            nav={nav}
            inflow={inflow}
            outflow={outflow}
            wide={wide}
            composerKey={composerKey}
            onSubmit={submit}
          />
        ) : nav.view === 'tasks' ? (
          <TasksView tasks={data.tasks} cursor={nav.cursor.list} />
        ) : nav.view === 'docs' ? (
          <DocsView client={client} port={port} cursor={nav.cursor.list} />
        ) : nav.view === 'threads' ? (
          <ThreadsView
            client={client}
            port={port}
            cursor={nav.cursor.list}
            canDecide={canDecide}
          />
        ) : nav.view === 'prs' ? (
          <PrsView
            client={client}
            port={port}
            cursor={nav.cursor.list}
            diff={nav.diff}
          />
        ) : (
          <RunsView
            client={client}
            port={port}
            runs={data.runs}
            cursor={nav.cursor.list}
            diff={nav.diff}
          />
        )}
      </box>
      <box height={1}>
        {session.revoked ? (
          <text fg={color.bad}>
            {' '}
            This window’s access was revoked. Run dispatch tui again.
          </text>
        ) : (
          <StatusLine nav={nav} error={data.error} readOnly={!canDecide} />
        )}
      </box>
    </box>
  );
}

const defaultClientFor = (project: Project): ApiClient =>
  createApiClient(`http://127.0.0.1:${project.port}`, project.agentToken);

/**
 * App plus its query cache, one per TUI process, with retries kept short so a dead daemon shows
 * fast. Switching project remounts App on the new daemon, so nothing from the last one lingers.
 */
export function TuiRoot(props: TuiProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, retryDelay: 500, refetchOnWindowFocus: false },
        },
      })
  );
  const [current, setCurrent] = useState({
    client: props.client,
    port: props.port,
    root: props.root,
    canDecide: props.canDecide,
  });
  const pick = (project: Project) =>
    setCurrent({
      client: (props.clientFor ?? defaultClientFor)(project),
      port: project.port,
      root: project.root,
      // The app token belongs to the daemon `dispatch tui` was started for.
      canDecide: project.root === props.root && props.canDecide,
    });
  return (
    <QueryClientProvider client={queryClient}>
      <CrashGuard onQuit={props.onQuit}>
        <App key={current.root} {...props} {...current} onPickProject={pick} />
      </CrashGuard>
    </QueryClientProvider>
  );
}
