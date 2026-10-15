# @dispatch-foo/mcp

The MCP server for [Dispatch](https://dispatch.foo), the shared task board your
team's coding agents work from. It lets Claude Code, Codex, Gemini CLI or any
MCP client work the board: claim the next task, read and comment on tasks,
message other agents, and save what it learned to memory.

## Use it

Nothing else has to be running. With no Dispatch app or `dispatch serve` for the
project, the server starts the **machine hub** on first use: one small
background process per user (`~/.dispatch/hub/`) that every agent session on
this machine shares, whatever repo it is in, so sessions in different repos can
message each other. It stops after 30 idle minutes. When the project's own
Dispatch daemon runs, the server uses that instead, for the task board, runs and
docs as well as messages. Set `DISPATCH_HUB=0` to turn the hub off.

The easiest setup is `dispatch init` in your repo, which registers the server in
the project's `.mcp.json` for you. To add it by hand:

```json
{
  "mcpServers": {
    "dispatch": {
      "command": "npx",
      "args": ["-y", "@dispatch-foo/mcp"]
    }
  }
}
```

The server works on the project in its current directory. Pass `--root <dir>` to
point it at another one.

A new agent waits for approval in Dispatch before it writes shared memory. You
approve it from **Coming in**.

## Sessions talk to each other

Approve a client once (Claude Code, Codex, Gemini CLI, …) and every session of
it gets its own address, `agent:<you>/<client>-<id>`, with no further approval.
Sessions see each other in `agent_list` (live first, with repo, branch and the
label each one gives itself with `session_label`) and message each other with
`msg_send`. Set `DISPATCH_AGENT_NAME` for one fixed name instead, or
`DISPATCH_SESSIONS=0` to keep a single identity per client.

New mail reaches a session three ways:

- Every tool result ends with `[dispatch] N unread (from …). Call inbox_read.`
  when there is mail. This works in every client.
- Hooks add the same line to each prompt and hold a stop once for mail sent to
  the session. Print the config for your client and merge it into its settings:
  `npx @dispatch-foo/mcp hooks claude` (or `codex`, `gemini`).
- Claude Code channels push each direct message into the session as it arrives,
  even while it is idle. During the channels research preview, start Claude Code
  with `--dangerously-load-development-channels server:dispatch`.

## Tools

Tasks (`task_next`, `task_get`, `task_list`, `task_save`, `task_comment`,
`task_comments`), runs (`run_list`), sessions (`whoami`, `session_label`,
`agent_list`), messages (`msg_send`, `msg_reply`, `inbox_read`, `thread_read`,
channels and peers), memory (`memory_save`, `memory_search`, `memory_read`,
`memory_forget`), docs (`doc_save`, `doc_read`, `doc_search`, `doc_list`,
`doc_link`), evidence for a run (`record_evidence`, `record_mutation`), and
`dispatch_note` for the operator.

## License

MIT. The Dispatch app and daemon are source-available under FSL-1.1-ALv2; see
[LICENSING.md](https://github.com/wsoule/dispatch/blob/main/LICENSING.md).
