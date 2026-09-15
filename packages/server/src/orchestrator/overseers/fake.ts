import type {
  OverseerBackend,
  OverseerToolResult,
  OverseerToolset,
  OverseerTurn,
} from '../overseerBackend.js';

/** One tool call a scripted turn makes, in the order the script lists them. */
interface FakeOverseerCall {
  tool: string;
  /**
   * The call's input. A function receives the results of this turn's *earlier*
   * calls, so a scripted turn can read state with one tool and target it with
   * the next (list the ready tasks, dispatch the first) instead of hard-coding
   * an id the test fixture would have to promise forever — the input-side
   * counterpart of FakeOverseerTurn's reply-as-function.
   */
  input?:
    | Record<string, unknown>
    | ((prior: OverseerToolResult[]) => Record<string, unknown>);
}

/** One scripted assistant turn: the calls it makes, then the text it replies with. */
export interface FakeOverseerTurn {
  calls?: FakeOverseerCall[];
  /**
   * The turn's reply. A function receives the results of this turn's own calls
   * — the same payloads a real model would have seen — so a test can assert
   * the assistant answered from them rather than from a canned string.
   */
  reply?: string | ((results: OverseerToolResult[]) => string);
}

// A scriptable stand-in for ClaudeOverseer (mirrors planners/fake.ts's
// FakePlanner). Three shapes:
//   - `{ ok: true, calls, reply }` — every turn makes the same calls and gives
//     the same reply; the simple one-shot stand-in.
//   - `{ ok: true, turns }`        — a scripted *sequence* of turns consumed in
//     order, so a test can drive ask -> queue -> confirm -> follow-up.
//   - `{ ok: false, error }`       — every turn rejects with this message.
export type FakeOverseerScript =
  | { ok: true; calls?: FakeOverseerCall[]; reply?: string }
  | { ok: true; turns: FakeOverseerTurn[] }
  | { ok: false; error: string };

// Used when a script omits an explicit `reply`.
const DEFAULT_REPLY = '(fake overseer turn)';

/** One call this backend made, with what the manager handed back. */
export interface FakeOverseerObservation {
  tool: string;
  input: unknown;
  result: OverseerToolResult;
}

/**
 * A deterministic tool-calling overseer backend for tests.
 *
 * It holds no *conversational* state: the position in the script is encoded in
 * the `sessionId` it hands back and OverseerManager threads into the next
 * `sendMessage` — `start()` consumes turn 0 and returns `'1'`, and so on. That
 * mirrors ClaudeOverseer's own statelessness (the real conversation lives in the
 * resumed Agent SDK session) and lets one instance be shared across every
 * conversation in the registry without their turns interfering.
 *
 * `observations` and `advertised` are pure test instrumentation: they record
 * what the "model" was told, which is how a test asserts that a mutating call
 * came back queued rather than done.
 */
export class FakeOverseer implements OverseerBackend {
  /** Every call made, oldest first, across every conversation. */
  readonly observations: FakeOverseerObservation[] = [];
  /** Tool names offered on the most recent turn, in the order advertised. */
  advertised: string[] = [];
  /** Prompts received, oldest first — the text the model would have read. */
  readonly prompts: string[] = [];

  constructor(private readonly script: FakeOverseerScript) {}

  async start(
    prompt: string,
    toolset: OverseerToolset,
    _model?: string
  ): Promise<OverseerTurn> {
    return this.runTurn(0, prompt, toolset);
  }

  async sendMessage(
    sessionId: string | undefined,
    message: string,
    toolset: OverseerToolset,
    _model?: string
  ): Promise<OverseerTurn> {
    const consumed =
      sessionId === undefined ? 0 : Number.parseInt(sessionId, 10);
    return this.runTurn(
      Number.isFinite(consumed) ? consumed : 0,
      message,
      toolset
    );
  }

  // Plays the turn at `index` (the number of turns already consumed): every
  // scripted call in order, then the reply.
  private async runTurn(
    index: number,
    prompt: string,
    toolset: OverseerToolset
  ): Promise<OverseerTurn> {
    if (!this.script.ok) {
      throw new Error(this.script.error);
    }
    this.prompts.push(prompt);
    this.advertised = toolset.tools.map((tool) => tool.name);

    const turn = this.turnAt(index);
    const results: OverseerToolResult[] = [];
    for (const call of turn.calls ?? []) {
      const input =
        typeof call.input === 'function' ? call.input(results) : call.input;
      const result = await toolset.call(call.tool, input ?? {});
      this.observations.push({
        tool: call.tool,
        input: input ?? {},
        result,
      });
      results.push(result);
    }
    const reply = turn.reply ?? DEFAULT_REPLY;
    return {
      reply: typeof reply === 'function' ? reply(results) : reply,
      sessionId: String(index + 1),
    };
  }

  private turnAt(index: number): FakeOverseerTurn {
    if (!this.script.ok) throw new Error(this.script.error);
    if (!('turns' in this.script)) {
      return { calls: this.script.calls, reply: this.script.reply };
    }
    const turn = this.script.turns[index];
    if (turn === undefined) {
      throw new Error(`FakeOverseer: no scripted turn at index ${index}`);
    }
    return turn;
  }
}
