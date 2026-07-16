# Running persistent Codex agents

## Session layout

A session directory is a private local control plane for one host process:

```text
session/
  state.json       host, loaded threads, active turns, pending requests
  events.jsonl     ordered App Server notifications and client lifecycle events
  inbox/           atomic local command submissions
  outbox/          atomic local command responses
```

The directory is mode `0700`; files are mode `0600`. Prompts and server request payloads can be sensitive. Do not place a session directory in a shared location.

Filesystem IPC does not replace the App Server protocol. It lets multiple local processes talk to the one host that owns App Server stdio. Only that host reads and writes JSON-RPC.

## Lifecycle

1. Start a host in a new session directory.
2. Let it spawn App Server, send `initialize`, wait for the response, then send `initialized`.
3. Start or resume a durable thread and retain it in the host.
4. Submit turns, reviews, steering, interrupts, and generic requests through the host.
5. Read all notifications and reverse requests until the matching turn is terminal.
6. Keep the host alive while the agent may receive another message.
7. Shut down only when no turn, reverse request, or local command lease is active.

Calling `turn` again with a thread already loaded by the host sends `turn/start` directly. `thread/resume` is for loading durable history into a new host after recovery.

## Protocol invariants

Treat a `turn/started` notification as provisional until the matching start request identifies the accepted turn. App Server can report a different provisional id while entering native review mode. Reconcile active state by thread, retain independent turns on other threads, and clear every alias for that thread when it becomes idle or its accepted turn completes. Never steer, interrupt, or refuse shutdown because of a provisional id left after a terminal review.

Discover reasoning effort capabilities from `model/list` on each App Server connection. Resolve the requested model, or the advertised default model, and validate an explicit effort against that model's `supportedReasoningEfforts`. Cache the normalized capability list for the connection. Do not maintain a global effort enum. If App Server rejects an effort it advertised, surface that failure without rewriting the capability data or weakening the test.

## State and events

`state.json` is the current snapshot. It includes:

- host PID and lifecycle status
- heartbeat time for detecting a stale PID or unresponsive host
- loaded thread ids
- active thread and turn pairs
- pending reverse request ids, methods, and parameters
- local lease count
- event file path and server initialization result

`events.jsonl` is the audit stream. Every entry keeps the App Server `method` and `params` and adds `_session.sequence` plus `_session.receivedAt`. Use the sequence as the cursor for external consumers.

Important methods include `item/started`, `item/completed`, deltas, `turn/diff/updated`, `turn/completed`, `error`, `client/serverRequest`, and `client/serverRequestResolved`.

Do not derive final success from silence, a completed assistant item, or the `turn/start` response. Use the matching `turn/completed` status.

## Multiple participants

Any authorized local process can:

- tail or parse the event stream
- inspect current state
- steer the one matching active turn
- interrupt it
- submit a new turn when the thread is idle
- inspect and answer reverse requests
- call other documented App Server methods

If more than one turn is active, steering and interruption require a thread or turn selector. The host refuses an ambiguous command.

## Reverse request policy

Interactive mode keeps reverse requests pending until `respond` supplies a result object. Use the installed App Server schema for exact response fields.

For user-input requests with `autoResolutionMs`, state includes `autoResolveAt`. The host returns empty answers at that deadline unless a participant responds first.

When App Server emits `serverRequest/resolved` before a local response, remove that request from pending state and do not send a late JSON-RPC response.

Unattended mode uses conservative defaults:

- command and file change approval: decline
- permission request: grant nothing for the current turn
- user input: return no answers
- MCP elicitation: cancel
- unimplemented dynamic tool: explicit failure

Surface pending requests as waiting state. Do not misclassify them as a stalled agent.

## Failure rules

On transport close:

- stop writes immediately
- reject every pending App Server RPC
- reject local turn waiters
- resolve or cancel reverse requests when possible
- mark session state closed with the transport error
- retain thread id, state, events, reports, and repository changes

Never start a host over an existing session directory. A stale inbox can contain a command whose acceptance is unknown. Use a new directory and load the durable thread there.

Never replay an accepted turn automatically. Only a failure before turn acceptance is generally retryable. After acceptance, inspect event history and thread state first.

## Tracked runs

Tracked exec and review runs store their session under `runs/<run_id>/app-server-session/`. Their metadata points to the host PID, session directory, thread id, event log, error log, and reports.

The initial turn client can exit while the host remains ready. A completed run therefore means the turn is terminal, not that the agent connection is gone.

`codex-delete.sh` shuts down an idle host before deleting a run. It refuses an active host unless forced. Deleting run artifacts does not delete the durable Codex thread.
