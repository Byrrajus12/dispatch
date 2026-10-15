import type {
  Address,
  FederationHooks,
  Message,
  MessageStore,
  MessagingHost,
  PolicyRuling,
  WakeResult,
} from '@dispatch-foo/protocol';

// The machine hub's MessagingHost: it homes agent sessions, not runs, so the
// run hooks are inert, and its one implicit channel family is `repo/<name>`:
// every live session working in that repo.

const REPO_CHANNEL = 'repo/';

export class HubHost implements MessagingHost {
  /** Set once the hub's links exist: placement for project mail. */
  federation?: FederationHooks;

  constructor(
    private readonly store: MessageStore,
    private readonly ownerRef: Address
  ) {}

  liveRunFor(): string | null {
    return null;
  }
  isLiveRun(): boolean {
    return false;
  }
  taskOfRun(): string | null {
    return null;
  }
  async push(): Promise<void> {}
  async notify(): Promise<void> {}
  notifyHuman(): void {}
  wake(): Promise<WakeResult> {
    return Promise.resolve({
      ok: false,
      reason: 'the machine hub runs no agents to wake',
    });
  }
  decide(): PolicyRuling {
    return 'allow';
  }
  owner(): Address {
    return this.ownerRef;
  }
  implicitMembers(channel: string): Address[] {
    if (!channel.startsWith(REPO_CHANNEL)) return [];
    const repo = channel.slice(REPO_CHANNEL.length);
    return this.store
      .agents()
      .filter(
        (a) =>
          a.status === 'approved' &&
          a.parent !== undefined &&
          a.meta?.repo === repo
      )
      .map((a) => a.address);
  }
  async onAnswered(_question: Message, _answer: Message): Promise<void> {}
  now(): Date {
    return new Date();
  }
}
