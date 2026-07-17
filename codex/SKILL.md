---
name: codex
description: Run and manage OpenAI Codex as a persistent bidirectional App Server agent. Use for implementation workers, code reviews, durable multi-turn conversations, streamed agent state, active steering or interruption, approvals and user-input requests, model or account inspection, thread lifecycle operations, and any request to delegate work to or converse with Codex.
---

# Codex App Server agents

Treat App Server as a long-lived agent connection, not as a one-shot command runner. Start one session host, keep reading its event stream, and send every turn, steer, interrupt, approval response, and protocol request through that host.

Use [scripts/codex-app-server.mjs](scripts/codex-app-server.mjs) for the transport and [references/RUNNING-CODEX-AGENTS.md](references/RUNNING-CODEX-AGENTS.md) for its files and recovery rules.

## Core model

Keep these lifetimes separate:

- A session host owns one initialized `codex app-server --listen stdio://` process and the bidirectional JSON-RPC stream.
- A thread is durable conversation history. One host can load and retain threads across turns.
- A turn is one active unit of work. It ends only at the matching `turn/completed` notification.
- An item is streamed work inside a turn, such as an agent message, command, file change, or tool call.
- A server request travels in the reverse direction. The host must answer approvals, user input, elicitation, and dynamic tool calls.

Do not close the host after a completed turn. Do not create a second App Server process to control an in-flight turn.

## Managed session workflow

Create a private session directory under the user state directory and start its host:

```bash
SESSION_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/boring-but-good/codex-app-server"
mkdir -p "$SESSION_ROOT" && chmod 700 "$SESSION_ROOT"
SESSION_DIR="$(mktemp -d "$SESSION_ROOT/session.XXXXXX")"
node scripts/codex-app-server.mjs start \
  --session-dir "$SESSION_DIR" \
  --events "$SESSION_DIR/events.jsonl" \
  --approval interactive
```

Start a thread and turn:

```bash
node scripts/codex-app-server.mjs turn \
  --session-dir "$SESSION_DIR" --new \
  --prompt "Inspect this repository and name its riskiest test gap." \
  --workdir . --sandbox read-only --effort low \
  --thread-out "$SESSION_DIR/thread.id" \
  --report "$SESSION_DIR/report.md"
```

The host stays ready after the command returns. Start later turns on the same host and thread:

```bash
node scripts/codex-app-server.mjs turn \
  --session-dir "$SESSION_DIR" \
  --thread "$(tr -d '[:space:]' < "$SESSION_DIR/thread.id")" \
  --prompt "Propose one focused regression test for that gap." \
  --workdir . --sandbox read-only
```

Observe and participate while a turn runs:

```bash
node scripts/codex-app-server.mjs status --session-dir "$SESSION_DIR"
tail -f "$SESSION_DIR/events.jsonl"
node scripts/codex-app-server.mjs steer --session-dir "$SESSION_DIR" \
  --prompt "Stop after the current test and summarize the result."
node scripts/codex-app-server.mjs interrupt --session-dir "$SESSION_DIR"
```

Close an idle host explicitly:

```bash
node scripts/codex-app-server.mjs shutdown --session-dir "$SESSION_DIR"
```

Shutdown refuses an active turn, unresolved server request, or another local command lease. Interrupt, respond, or wait first. Once shutdown is accepted, the host stops accepting commands before it drains work. Use `--force` only when deliberate cancellation and invalidation of other requests is acceptable.

## Reverse requests

Use `--approval interactive` when a person or another controller will answer App Server requests. Pending requests remain visible in session state:

```bash
node scripts/codex-app-server.mjs pending --session-dir "$SESSION_DIR"
node scripts/codex-app-server.mjs respond \
  --session-dir "$SESSION_DIR" --request 42 \
  --result-file /tmp/app-server-response.json
```

The response file must contain the exact result object required by the local version's generated schema. For command and file-change approvals, `--decision decline` is a convenient safe response.

Use `--approval decline` for unattended work. It safely declines command and file-change approvals, grants no requested permissions for the turn, returns empty user input, cancels MCP elicitation, and rejects unimplemented dynamic tools. `accept` grants exactly the requested permission subset for the current turn. `accept-for-session` grants that same subset for the session. Use either accepting mode only for an isolated client and an explicit user decision.

Never leave a server request unresolved without surfacing that the turn is waiting. `codex-status.sh` and `codex-exec-status.sh` report `pending_requests` and use the `waiting` verdict.

When `item/tool/requestUserInput` includes `autoResolutionMs`, the host exposes `autoResolveAt` and returns empty answers at that deadline if nobody responds first.

## Tracked agents

Use the tracked wrappers for normal repository work. Each run owns one persistent session host, central event stream, durable thread id, report, and status record.

```bash
# Implementation worker
scripts/codex-exec-start.sh --workdir ~/repo --sandbox workspace-write \
  --title "fix flaky retry" \
  "Make test/client.test.ts deterministic. Run the focused test."

# Supervised worker that can ask for approvals or user input
scripts/codex-exec-start.sh --workdir ~/repo --approval interactive \
  "Update the dependency and stop if an approval is needed."

# Native code review
scripts/codex-review-start.sh --base main --preset security \
  --prompt "Prioritize auth boundaries and leaked secrets."

# Steer an active turn, or start a new turn when the host is idle
scripts/codex-review-converse.sh <run_id> \
  "Challenge the highest-severity finding and keep only proven issues."

scripts/codex-status.sh <run_id> --json
scripts/codex-watch.sh <run_id>
scripts/codex-exec-stop.sh <run_id>
scripts/codex-delete.sh <run_id>
```

The wrappers default to `--approval decline`. Add `--approval interactive` only when something will monitor and answer requests. `--wait` waits for the initial turn, but the session host remains alive for later conversation.

Do not modify the same working tree while an implementation turn is active.

## Reviews

Use `review/start` through the managed host for uncommitted, base branch, commit, or custom targets. A review can receive a separate lens through developer instructions. A validated review effort belongs in the new thread's `config.model_reasoning_effort`; do not add an unsupported effort field to `review/start`.

Review findings are evidence, not facts. Verify each finding against code and tests. After code changes, prefer a new review thread because an old review thread retains its earlier diff context.

## Full protocol requests

Send documented requests through the existing host:

```bash
node scripts/codex-app-server.mjs request --session-dir "$SESSION_DIR" --method model/list
node scripts/codex-app-server.mjs request --session-dir "$SESSION_DIR" \
  --method thread/read --params-file /tmp/thread-read.json
```

Use this for thread start, resume, read, list, fork, archive, delete, compaction, naming and goals, account state, model discovery, config, apps, plugins, MCP status, filesystem watches, and other documented surfaces. Treat `thread/shellCommand` as an explicit user action because it runs outside the thread sandbox.

Generate the exact schema from the installed CLI before adding a typed wrapper:

```bash
codex app-server generate-ts --out /tmp/codex-app-server-schema
codex app-server generate-json-schema --out /tmp/codex-app-server-schema
```

## Safety and recovery

1. Persist the thread id as soon as `thread/start` or `thread/resume` returns.
2. Archive every notification with a monotonic local sequence.
3. Treat `turn/start` as acceptance, not completion.
4. Hold a session lease for every local command. Non-force shutdown must reject while another lease exists, and accepted shutdown must atomically close command admission.
5. On transport close, reject all pending RPCs and local waiters with the same close error.
6. Never replay an accepted turn after timeout or transport close. It may have run commands or changed files. After a timeout, interrupt once and wait only for a bounded terminal-notification grace period. Close the client and managed host if completion remains unknown.
7. Resume a durable thread only from a new, empty session directory. Never reuse a stale inbox.
8. Recover a completed assistant item after close only when no command, file change, MCP call, or dynamic tool remains unresolved.
9. Authenticate every filesystem IPC command and response. The host key belongs in the user state directory, outside the session tree and normal workspace-write roots. Never copy it into arguments, state, events, logs, or command payloads. Ignore unsigned or invalid outbox data without deleting it, then wait for the authenticated host response.

Use `read-only` for discussion and review. Use `workspace-write` for scoped implementation. `danger-full-access` requires an explicit user decision and an isolated worktree.

Directory mode `0700` alone is not an authorization boundary against a workspace-write process running as the same user. Before any model, thread, turn, or review request, managed workspace-write validates the real session and credential paths against the workdir, canonical `/tmp`, and `$TMPDIR`, then rejects placement inside any effective writable root. Managed commands and responses use a per-session HMAC credential, and the host rejects forged or replayed command ids. `danger-full-access` can read same-user state, including command credentials, so filesystem authentication cannot isolate a danger-full-access agent from its controller. Use an OS-level identity or container boundary when that isolation is required.

## Compatibility

The direct `turn`, `review`, and `request` commands still support isolated operation when `--session-dir` is omitted. Use this only for diagnostics or a truly one-shot request. `--control-dir` is legacy compatibility for an isolated active turn.

Do not start new `codex mcp-server` conversations. The old `codex-mcp-*.sh` scripts remain only for archived runs.

## Validation

```bash
tests/run-tests.sh --offline
tests/run-tests.sh
```

The offline fake server covers handshake ordering, persistent connection reuse, loaded-thread continuation, notification races, delayed reverse-request archival, ordered events, native reviews, multi-process steering and interruption, interactive reverse requests, safe automatic request responses, atomic lease-aware shutdown, authenticated command and response IPC, replay resistance, managed workspace-write placement, private artifact modes, generic requests, orphaned waiter reconciliation, timeout without replay, transport close, and tracked wrapper lifecycle. The live suite exercises the installed App Server.

Official reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server).
