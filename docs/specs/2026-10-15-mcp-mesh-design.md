# MCP mesh: sessions, a machine hub and a hosted team

Status: approved direction (Wyat, 2026-10-15). Pieces 1–5 below each get their
own plan; piece 1 is specified to implementation depth here, the rest to the
depth their own spec will start from.

## Why

The product is the connective layer between agents, tasks and Linear, agent
agnostic. The desktop app stays first-class but is one client of that layer. The
promise: add `@dispatch-foo/mcp` to any coding agent and every session can find,
message and hand work to every other session: in the same repo, in another repo
on the same machine, and on a teammate's machine.

Today that breaks in five places:

1. **Sessions share one identity.** `agentName()` is `<client>.<host>`, so two
   Claude Code sessions in one repo register as the same agent and read one
   inbox.
2. **A daemon must already run.** Every messaging call fails with "dispatchd not
   running" unless the app or `dispatch serve` started it; npm users have no way
   to get one.
3. **Delivery is pull-only.** A session sees a message only when it calls
   `inbox_read`.
4. **Messaging is per repo.** One `messages.db` per project, so sessions in
   different repos cannot see each other.
5. **Approval lives in the app.** Each new agent name opens an approval gate
   only the desktop app surfaces.

## Decisions

- One addressing design for all three scales; build same-machine first.
- Install bar: **only the MCP.** It starts whatever it needs.
- Architecture: a **machine-wide local hub** (one per OS user) owns session
  identity and agent mail; a **hosted team site** owns accounts, team setup,
  invites, Linear and the cross-machine view; hubs federate over the existing
  relay. (Chosen over hosted-first so same-machine works offline with no
  account.)
- Agent mail moves out of the per-project daemon into the hub; dispatchd becomes
  a hub client for it and keeps its orchestration gates.

## Addresses

No grammar change. Everything stays `agent:<operator>/<name>`
(`packages/protocol/src/address.ts`).

- `<operator>`: the human handle. Locally, the OS user (or the team handle once
  the hub is signed in to a team).
- `<name>` for a session: `<client>-<sid>`, e.g. `claude-code-7f3a2c`,
  `codex-19be04`. `<sid>` is the first 6 hex of sha256 of the session key
  (below), so a session keeps its address across MCP restarts within one agent
  session.
- Session key, first present wins: `DISPATCH_SESSION_ID`,
  `CLAUDE_CODE_SESSION_ID`, `CODEX_SESSION_ID`, `GEMINI_SESSION_ID`, else a
  random id per MCP process.
- `DISPATCH_AGENT_NAME` still overrides the whole name (stable named agents,
  e.g. `reviewer`).
- `run:<id>` stays the address of a dispatched run.
- Repo channels: `channel:repo/<slug>`, implicit members = live sessions whose
  cwd is in that repo. `epic/<id>` channels stay with dispatchd.

## Piece 1 — Per-session identity, presence and unread delivery (MCP + server)

Works against today's per-project dispatchd; moves to the hub unchanged in piece
2 because it only uses the register/roster/mailbox routes.

### Identity and approval

- The MCP registers `<client>-<sid>` with metadata
  `{kind: 'session', client, cwd, repo, branch, label?, pid}`.
- **Approve the client once, not every session.** The first registration for a
  `(operator, client)` pair raises today's `agent-registration` gate. Once a
  client is approved, later session registrations for it carry
  `parent: <approved agent address>` and the parent's token as proof; the server
  approves them immediately. Revoking the parent revokes its sessions.
  - The parent is the existing `<client>.<host>` identity, kept as the client's
    trust anchor (cached at the same `~/.dispatch/agents/...` path).
  - Session tokens are cached at `.../agents/<projectKey>/sessions/<sid>.json`.
- Sessions are ephemeral: `lastSeen` updates on every authenticated request; a
  session idle for 24h is pruned from the roster (its mail stays readable by its
  parent's sessions via `thread_read`).

### Presence

- `agent_list` gains `online` (seen in the last 2 minutes), `kind`, `client`,
  `repo`, `branch`, `label`, `lastSeen`, and sorts live sessions first, grouped
  by repo.
- New tool `session_label({label})`: a session names itself ("auth refactor",
  "release notes") so peers can pick it out.
- `whoami` tool: this session's address, parent, repo, unread count.

### Delivery (layered, best available wins; read state only changes in

`inbox_read`)

1. **Unread footer on every tool result** (all clients). When this session has
   unread deliveries, append one text block
   `[dispatch] 2 unread (from agent:wyat/codex-19be04, channel:repo/dispatch). Call inbox_read.`
   and `_meta: {"dispatch/unread": 2}`. Bodies never go in the footer. The count
   comes from a cached mailbox probe refreshed at most every 5s.
2. **Hooks** (Claude Code, Codex, Gemini): `dispatch-mcp hook <event>` prints
   the client's `additionalContext` JSON for UserPromptSubmit/PostToolUse when
   there is unread mail, and for Stop blocks once (`decision: block`) only when
   unread mail is addressed to this session directly. `dispatch-mcp install`
   writes the hook config for detected clients (opt-in, prints a diff first).
3. **Claude Code channel push** (opt-in): the server declares
   `experimental['claude/channel']` and emits
   `notifications/claude/channel {content, meta: {from, thread, msg_id}}` per
   new direct message from an approved sender. Marked `pushed`, never `read`.
   Requires `--dangerously-load-development-channels server:dispatch` until the
   plugin is allowlisted; stays on MCP SDK 1.x.

### Server changes (packages/server/src/messaging/routes.ts)

- `POST /api/agents/register` accepts `{parent, parentToken, meta}`; a matching
  approved parent approves the session row immediately (no gate).
- `agents` rows store `meta` (JSON) and `last_seen`; roster returns them.
- `GET /api/mailbox?unread=count` cheap count for the footer.
- Prune sweep for idle session rows.
- Protocol store: additive migration for `meta`, `last_seen`, `parent`.

### Tests

MCP: identity naming from each env var, parent→session registration, footer
present/absent, hook output shapes per client. Server: parent auto-approval,
revoke cascade, prune, count route. One e2e: two MCP servers in one repo message
each other and each sees the other's footer.

## Piece 2 — The machine hub (inside `@dispatch-foo/mcp`, MIT)

Built as `packages/mcp/src/hub/` rather than a new package, so
`npx @dispatch-foo/mcp` stays the only install and no new npm package needs
publishing. Until piece 3, an MCP server uses its project's dispatchd when one
runs and the hub otherwise (`packages/mcp/src/endpoint.ts`).

- **What:** a Node (≥22.13, `node:sqlite`) process built on
  `@dispatch-foo/protocol`'s `DeliveryEngine` + `SqliteMessageStore`, with a
  small `MessagingHost` that knows sessions, not runs. One per OS user.
- **State:** `~/.dispatch/hub/` — `messages.db`, `hub.json`
  (`{port, pid, token, version}` 0600), `hub.lock`.
- **Start:** the MCP reads `hub.json`, health-checks, and if absent spawns
  `dispatch-mcp hub` detached behind `hub.lock` (O_EXCL, stale-pid takeover).
  The hub ships inside `@dispatch-foo/mcp` as a subcommand, so `npx` is still
  the only install. Idle shutdown 30 min after the last session disconnects.
- **Routes:** the same self-authenticated messaging routes the MCP already calls
  (`/api/messages`, `/api/mailbox`, `/api/threads`, `/api/channels`,
  `/api/agents/register|roster`), so the MCP's client code is shared by pointing
  it at the hub port instead of a project daemon.
- **Approval without the app:** the hub's owner principal is the local user.
  First-client approval is answered by `dispatch-mcp approve <client>` in a
  terminal, by the desktop app (a hub client), or by the team site once signed
  in. Default policy for a hub with no team: auto-approve clients started by the
  same OS user (the token file is already 0600 to that user); a team can require
  approval.
- **Cross-repo:** sessions from every repo register with the one hub; repo is
  metadata, so a session in `~/Sites/api` messages one in `~/Sites/web`
  directly.
- **License:** hub core MIT (single-user, multi-session messaging is free core);
  `packages/hub/src/team/` ELv2 like `server/src/team/`. Added to
  `scripts/check-licenses.ts`.

## Piece 3 — dispatchd becomes a hub client

- dispatchd connects to the hub as a **home** for the addresses it owns
  (`run:*`, `task:*`, `epic/<id>` channels, `human:` decision gates). The hub
  routes mail for those addresses to dispatchd over a long-lived connection;
  dispatchd keeps its gates (wake, tool approval, scope, overseer) and
  orchestration hooks exactly where they are.
- Dispatched runs register as hub sessions (parent = the project's dispatchd
  identity), so a run and a hand-driven Codex session see each other in
  `agent_list`.
- Migration: existing `messages.db` agent rows and agent↔agent threads copy into
  the hub on first connect with count parity; gate tables stay.
- The desktop app reads presence and agent mail from the hub, project state from
  dispatchd.

## Piece 4 — Hosted team site (`app.dispatch.foo`, private repo with the relay)

- **Accounts:** GitHub OAuth + email magic link. A person = account ↔ handle.
- **Team setup:** create team, invite by email/link (the existing
  `dispatch.foo/join#…` links land here), seats/license, members, revoke.
- **Hub login:** RFC 8628 device code. `dispatch_login` tool (or
  `dispatch-mcp login`) prints a code; the user approves on the site and picks a
  team; the site hands the hub an invite seed and the hub joins via the existing
  federation `join` path.
- **Admission without an admin's laptop:** the team gets a **web admin replica**
  whose signing key the site holds, opt-in at team creation, so the site can
  sign `admit`. Teams that refuse custody keep today's admin-machine admission.
  _Open trust decision — confirm before building._
- **Presence:** new `PresenceBody` kind `session` (protocol version bump) so the
  site and teammates' hubs see live sessions; message bodies stay sealed and
  invisible to the site.
- **Cross-machine addressing:** `agent:<teammate>/<session>` resolves through
  `Homes.of` to the teammate's hub replica; mail travels as sealed `mail` ops.

## Piece 5 — Linear through the team

- The site holds a Linear OAuth app token per team and the one webhook per
  Linear team; it is the only Linear writer for a team.
- Hubs/dispatchd send task ops to the site over the relay; the site maps and
  writes Linear, then fans mapped updates back. Cursors, merge bases, echoes and
  conflicts move from `~/.dispatch/linear/*.json` to the site.
- `linear:` config (teamIds, statusMap, direction) becomes a team setting;
  per-project personal-key sync remains for users with no team.

## Build order

1 → 2 → 3 → 4 → 5. Each lands as its own PR (or PR series) green on
`root:format`, `root:lint`, typecheck and focused tests.

## Decided (Wyat, 2026-10-15)

1. **Hub ↔ dispatchd: loopback federation.** The hub and each project's
   dispatchd exchange messages as two local replicas through the protocol's
   `engine.receive()` path, so threads span both stores and senders keep their
   addresses. dispatchd keeps its store and gates; its `placement()` homes
   `agent:` sessions at the hub.
2. **Hub approval with no team: auto-approve same-OS-user clients.** A team can
   require approval again.
3. **Web admin replica: opt-in at team creation.** Teams that decline keep
   admin-machine admission.
4. **Team site: the private relay repo** (`wsoule/dispatch-relay`).
