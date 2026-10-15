import { afterEach, describe, expect, it } from 'bun:test';

import { DeliveryEngine } from '../src/engine.js';
import type { FederationHooks, MessagingHost, Placement } from '../src/host.js';
import type { LinkMail, LinkState } from '../src/link.js';
import { applyLinkMail, applyLinkState, LoopbackLink } from '../src/link.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';

// Two replicas on one machine, linked back to back: each homes its own agents
// and places the other's at the peer.

interface Side {
  name: string;
  store: SqliteMessageStore;
  engine: DeliveryEngine;
  link: LoopbackLink;
  close(): void;
}

let sides: Side[] = [];
afterEach(() => {
  for (const s of sides) {
    s.link.stop();
    s.close();
  }
  sides = [];
});

function side(name: string, owns: (address: string) => boolean): Side {
  const db = openMessagesDb(':memory:');
  const store = new SqliteMessageStore(db);
  let tick = 0;
  const federation: FederationHooks = {
    replica: name,
    hlc: () =>
      `${String(Date.now()).padStart(13, '0')}-${String(tick++).padStart(4, '0')}-${name}`,
    placement: (target): Placement =>
      owns(target.recipient)
        ? { kind: 'local' }
        : { kind: 'remote', homes: [peerOf(name)], alsoLocal: false },
    remoteRunTask: () => null,
    label: (r) => r,
    problem: () => {},
  };
  const host: MessagingHost = {
    liveRunFor: () => null,
    isLiveRun: () => false,
    taskOfRun: () => null,
    push: async () => {},
    notify: async () => {},
    notifyHuman: () => {},
    wake: async () => ({ ok: false, reason: 'none' }),
    decide: () => 'allow',
    owner: () => 'human:wyat',
    implicitMembers: () => [],
    onAnswered: async () => {},
    now: () => new Date(),
    federation,
  };
  const engine = new DeliveryEngine({ store, host });
  for (const address of ['agent:wyat/session-a', 'agent:wyat/session-b'])
    store.putAgent({
      address,
      displayName: address,
      client: 'test',
      tokenHash: `h-${address}-${name}`,
      status: 'approved',
      muted: false,
      approvedBy: 'human:wyat',
      createdAt: new Date().toISOString(),
    });
  const s: Side = {
    name,
    store,
    engine,
    link: null as unknown as LoopbackLink,
    close: () => db.close(),
  };
  s.link = new LoopbackLink({
    engine,
    store,
    me: name,
    peer: peerOf(name),
    send: async (kind, body) => {
      const other = sides.find((o) => o.name === peerOf(name))!;
      if (kind === 'mail')
        await applyLinkMail(other.engine, other.link, name, body as LinkMail);
      else applyLinkState(other.engine, other.store, name, body as LinkState);
      return true;
    },
  });
  sides.push(s);
  return s;
}

function peerOf(name: string): string {
  return name === '@hub-00000001' ? '@local-00000002' : '@hub-00000001';
}

describe('LoopbackLink', () => {
  it('carries a message, its delivery state and the reply in one thread', async () => {
    const hub = side('@hub-00000001', (a) => a.endsWith('/session-a'));
    const daemon = side('@local-00000002', (a) => a.endsWith('/session-b'));
    hub.link.start();
    daemon.link.start();

    const sent = await hub.engine.send(
      {
        to: ['agent:wyat/session-b'],
        kind: 'message',
        body: 'take the migration?',
      },
      { address: 'agent:wyat/session-a', canDecide: false }
    );
    await hub.link.flush();
    const there = daemon.engine.inbox('agent:wyat/session-b');
    expect(there.map((i) => i.message.body)).toEqual(['take the migration?']);

    // The delivery state flows back, so the row stops being resent.
    await daemon.link.flush();
    const row = hub.store.remoteDeliveries({ messageId: sent.message.id })[0];
    expect(row.state).not.toBe('forwarded');

    const reply = await daemon.engine.reply(
      sent.message.id,
      { body: 'on it' },
      { address: 'agent:wyat/session-b', canDecide: false }
    );
    await daemon.link.flush();
    const back = hub.engine.inbox('agent:wyat/session-a');
    expect(back.map((i) => i.message.body)).toEqual(['on it']);
    expect(back[0].message.thread).toBe(sent.message.thread);
    expect(reply.message.thread).toBe(sent.message.thread);
  });

  it('sends unacknowledged mail again and the peer stores it once', async () => {
    const hub = side('@hub-00000001', (a) => a.endsWith('/session-a'));
    const daemon = side('@local-00000002', (a) => a.endsWith('/session-b'));
    await hub.engine.send(
      { to: ['agent:wyat/session-b'], kind: 'message', body: 'once' },
      { address: 'agent:wyat/session-a', canDecide: false }
    );
    await hub.link.flush();
    await hub.link.flush();
    expect(daemon.engine.inbox('agent:wyat/session-b')).toHaveLength(1);
  });
});
