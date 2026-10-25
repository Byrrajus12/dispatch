import type {
  ApiClient,
  NormalizedEntry,
  RunDetail,
  RunMeta,
} from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'bun:test';
import type { ReactNode } from 'react';

import { applyRunEvent, runDetailKey, useRunDetail } from './useRunData';

const PORT = 4100;
const RUN = 'r-000001';

function entry(text: string): NormalizedEntry {
  return { ts: '2026-10-25T10:00:00.000Z', kind: 'assistant', text };
}

// A daemon whose run detail reads can be held open, standing in for a fetch
// that is in flight when a run.log frame arrives. `log` appends an entry the
// way the daemon does: to the transcript first, then the frame.
function gatedRunServer() {
  const entries: NormalizedEntry[] = [entry('first')];
  const pending: (() => void)[] = [];
  const server = {
    gated: false,
    pending,
    fetches: 0,
    client: {
      fetchRun: () => {
        server.fetches += 1;
        const snapshot: RunDetail = {
          meta: { id: RUN, state: 'running' } as RunMeta,
          entries: [...entries],
          evidence: [],
          mutations: [],
        };
        if (!server.gated) return Promise.resolve(snapshot);
        return new Promise<RunDetail>((resolve) => {
          pending.push(() => resolve(snapshot));
        });
      },
    } as unknown as ApiClient,
    log(qc: QueryClient, text: string) {
      const next = entry(text);
      entries.push(next);
      applyRunEvent(qc, PORT, { type: 'run.log', runId: RUN, entry: next });
    },
    release() {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
  return server;
}

function mount(client: ApiClient) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return {
    qc,
    ...renderHook(() => useRunDetail(client, PORT, RUN), { wrapper }),
  };
}

const texts = (detail: RunDetail | undefined) =>
  detail?.entries.map((e) => e.text);

describe('applyRunEvent run.log', () => {
  it('appends to a cached detail and leaves an uncached run alone', () => {
    const qc = new QueryClient();
    qc.setQueryData<RunDetail>(runDetailKey(PORT, RUN), {
      meta: { id: RUN } as RunMeta,
      entries: [entry('first')],
      evidence: [],
      mutations: [],
    });
    applyRunEvent(qc, PORT, {
      type: 'run.log',
      runId: RUN,
      entry: entry('second'),
    });
    applyRunEvent(qc, PORT, {
      type: 'run.log',
      runId: 'r-000002',
      entry: entry('elsewhere'),
    });
    expect(texts(qc.getQueryData<RunDetail>(runDetailKey(PORT, RUN)))).toEqual([
      'first',
      'second',
    ]);
    expect(qc.getQueryData(runDetailKey(PORT, 'r-000002'))).toBeUndefined();
  });

  // The fetch was read before the entry was logged, so landing as it is would
  // wipe the entry the frame just appended.
  it('keeps an entry logged while the detail is first fetched', async () => {
    const server = gatedRunServer();
    server.gated = true;
    const { qc, result } = mount(server.client);
    await waitFor(() => {
      expect(server.pending).toHaveLength(1);
    });
    server.log(qc, 'second');
    server.gated = false;
    server.release();
    await waitFor(() => {
      expect(qc.isFetching()).toBe(0);
      expect(texts(result.current)).toEqual(['first', 'second']);
    });
    expect(qc.getQueryState(runDetailKey(PORT, RUN))?.status).toBe('success');
  });

  it('keeps an entry logged during a background refetch', async () => {
    const server = gatedRunServer();
    const { qc, result } = mount(server.client);
    await waitFor(() => {
      expect(texts(result.current)).toEqual(['first']);
    });
    server.gated = true;
    void qc.invalidateQueries({ queryKey: runDetailKey(PORT, RUN) });
    await waitFor(() => {
      expect(server.pending).toHaveLength(1);
    });
    server.log(qc, 'second');
    // Shown at once, while the repair fetch is still out.
    await waitFor(() => {
      expect(texts(result.current)).toEqual(['first', 'second']);
    });
    server.gated = false;
    server.release();
    await waitFor(() => {
      expect(qc.isFetching()).toBe(0);
      expect(texts(result.current)).toEqual(['first', 'second']);
    });
    expect(qc.getQueryState(runDetailKey(PORT, RUN))?.status).toBe('success');
  });
});
