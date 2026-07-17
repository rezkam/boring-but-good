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

The directory is mode `0700`; files are mode `0600`. Prompts and server request payloads can be sensitive. Keep persistent sessions under `${XDG_STATE_HOME:-$HOME/.local/state}/boring-but-good/codex-app-server`, not in `/tmp` or a repository.

The host generates a separate mode `0600` command key under the user state directory, outside the session tree and normal workspace-write roots. Clients HMAC-sign the canonical command body. The host requires a canonical UUID filename that matches the signed command id, consumes each id once, and constructs outbox paths only from the validated filename. The raw key never belongs in CLI arguments, state, events, logs, inbox files, or outbox files. Terminal shutdown and failed startup remove it.

Mode `0700` is not an authorization boundary against another same-UID process that can reach the directory, so authentication is required even with the safer default location. A `danger-full-access` turn can read same-user credentials and cannot be isolated by this filesystem design. Use a separate OS identity or container when the agent must not reach controller credentials.

Filesystem IPC does not replace the App Server protocol. It lets multiple local processes talk to the one host that owns App Server stdio. Only that host reads and writes JSON-RPC.

## Lifecycle

1. Start a host in a new session directory.
2. Let it spawn App Server, send `initialize`, wait for the response, then send `initialized`.
3. Start or resume a durable thread and retain it in the host.
4. Submit turns, reviews, steering, interrupts, and generic requests through the host.
5. Read all notifications and reverse requests until the matching turn is terminal.
6. Keep the host alive while the agent may receive another message.
7. Shut down only when no turn, reverse request, or other local command lease is active. Accepted shutdown closes command admission atomically before draining tasks. Force shutdown may invalidate other requests.

Calling `turn` again with a thread already loaded by the host sends `turn/start` directly. `thread/resume` is for loading durable history into a new host after recovery.

## Protocol invariants

Treat a `turn/started` notification as provisional until the matching start request identifies the accepted turn. App Server can report a different provisional id while entering native review mode. Reconcile active state by thread, retain independent turns on other threads, and clear every alias for that thread when it becomes idle or its accepted turn completes. Never steer, interrupt, or refuse shutdown because of a provisional id left after a terminal review.

Discover reasoning effort capabilities from the complete `model/list` catalog on each App Server connection. Send `includeHidden: true`, follow every `nextCursor`, reject repeated cursors, then cache the normalized full catalog for the connection. Resolve the requested model, or the advertised default model, and validate an explicit effort against that model's `supportedReasoningEfforts`. Do not maintain a global effort enum. Put a validated native review effort in `thread/start` as `config.model_reasoning_effort`, not in `review/start`. If App Server rejects an effort it advertised, surface that failure without rewriting the capability data or weakening the test.

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

Explicit `accept` grants exactly the permission subset in the request with turn scope. `accept-for-session` grants that exact subset with session scope. Do not broaden a requested permission profile.

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

New tracked metadata stores the persistent host in `pid` and the initial short waiter in `turn_client_pid`. If that waiter disappears after acceptance, status may persist `completed` from a non-empty report only when session state is valid, is `ready`, `closing`, or `closed`, and proves zero active turns, pending requests, and command leases. Legacy metadata without `turn_client_pid` retains the dead-wrapper fallback. Never infer completion while any of those host activities remains.

`codex-delete.sh` shuts down an idle host before deleting a run. It refuses an active host unless forced. Deleting run artifacts does not delete the durable Codex thread.
