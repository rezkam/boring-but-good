---
name: codex
description: Drive the OpenAI Codex CLI non-interactively as a second agent. Use for Codex review sessions, persistent MCP conversations, exec worker delegation, liveness checks, status polling, reports, follow-up turns, stopping runs, and deleting run records. Trigger whenever the user mentions codex, codex review, adversarial or second-opinion review, talking to codex, continuous back-and-forth with codex, launching codex in MCP mode, delegating or scheduling implementation work to codex, checking whether a codex run is alive or progressing, managing codex sessions, cleaning up codex runs, or orchestrating codex as a non-interactive worker or reviewer from automation or workflows.
compatibility: Requires the OpenAI codex CLI (verified on 0.142.5) and jq, with GNU coreutils in PATH. Built for non-interactive automation; no TTY needed.
---

# Codex

Tools for using the `codex` CLI as a second agent from non-interactive automation. Three modes, one shared run store:

| Mode | Use when | Entry point |
| --- | --- | --- |
| Review session | You want a tracked one-shot code review of a diff (background job, pollable, report on disk) | `scripts/codex-review-start.sh` |
| MCP conversation | You want a continuous multi-turn dialogue: adversarial discussion, review synthesis across rounds, design debate. Context persists across turns because the same server process holds the thread | `scripts/codex-mcp-start.sh` |
| Exec worker | You delegate a well-defined implementation task to Codex as a tracked background job you can health-check while doing other work | `scripts/codex-exec-start.sh` |

Two standing policies. Run a review proactively when you finish a substantive change (refactor, tricky algorithm, security-sensitive code) before presenting it as done; skip it for trivial edits. Delegate implementation to Codex only when the user explicitly asks for Codex to do it, and never re-delegate follow-up work without a fresh ask.

All runs live under `${CODEX_REVIEW_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/codex-review}/runs/<run_id>/` with a `meta.json`, logs, and archived turn transcripts. `scripts/codex-review-list.sh` lists every run of both kinds; `scripts/codex-delete.sh` removes runs from the store (see Deleting runs).

## Files

- `references/RUNNING-CODEX-AGENTS.md` living field guide for exec-mode implementation runs and their failure modes (prompting discipline, hang signatures, stall/quota detection, verification checklist) plus the verified MCP session-continuation semantics and CLI traps. Read it before orchestrating Codex as a worker; append new verified learnings.
- `scripts/codex-review-start.sh|status|report|converse|list` review session lifecycle
- `scripts/codex-mcp-start.sh|send|status|stop` MCP conversation lifecycle
- `scripts/codex-exec-start.sh|status|stop` exec worker lifecycle (follow-ups go through `codex-review-converse.sh`)
- `scripts/codex-status.sh` one status command for ANY run kind, same JSON shape and verdict everywhere
- `scripts/codex-watch.sh` the listener: one line per verdict transition, exit code tells the outcome
- `scripts/codex-delete.sh` remove runs of any kind from the store
- `scripts/_helpers.sh` shared metadata, locking, MCP plumbing
- `tests/run-tests.sh` the test suite (see Testing)

## Review sessions

```bash
scripts/codex-review-start.sh --uncommitted --preset adversarial
scripts/codex-review-start.sh --base main --title "Security sweep" --preset security --prompt "Focus on auth and data leakage"
scripts/codex-review-start.sh --commit HEAD~1 --model gpt-5.4 --prompt-file /tmp/review.txt
scripts/codex-review-start.sh --wait --uncommitted --config model_reasoning_effort=low   # foreground, cheap
```

Scope with `--uncommitted` (default), `--base <branch>`, or `--commit <sha>`. Shape the review with `--preset <adversarial|security|architecture|completeness>`, `--prompt`/`--prompt-file`, `--model`, `--effort`, and repeatable `--config k=v` (any codex `-c` override). `--workdir` picks the repo; `--wait` runs foreground and prints the report.

Effort and model defaults, everywhere: every entry point (`review-start`, `exec-start`, `mcp-start`, `mcp-send` opening turns, `converse`) takes `--effort <minimal|low|medium|high|xhigh>` and `--model <name>`, both validated. Leave BOTH unset for real work: the defaults come from codex's own config, which is the right baseline; tighten the prompt before raising effort. Use `--effort low` for smoke tests and cheap probes (the test suite does). The chosen effort is recorded in the run metadata. Resume is the exception: `converse` (and `exec resume` under the hood) does NOT carry the original session's effort/model forward, so `codex exec resume` would silently fall back to the model's config default (e.g. `xhigh` for gpt-5.5). `converse` therefore defaults `--effort`/`--model` to the run's recorded meta so a follow-up stays at the tier the run was started with; pass the flags to override. When a run must stay at a fixed tier across fix rounds (e.g. an impl campaign pinned to `medium`), start it with `--effort medium` so every resume inherits it.

One hard CLI limit (codex-cli 0.142.5): presets and custom prompts only combine with the uncommitted scope. The codex binary rejects scope flags together with review instructions, so `--base`/`--commit` reviews run preset-less; the script refuses the combination with a clear error. To shape a scoped review, start it plain and follow up with `codex-review-converse.sh`. The adversarial preset carries an anchored severity rubric (P0 = crash, data loss, or wrong results on documented valid input; P1 = edge-case or security; P2 = risky but correct; P3 = style) so severity labels are comparable across runs.

The start script prints a `run_id`. Then:

```bash
scripts/codex-review-status.sh "$run_id"        # state + recent activity (--follow, --json)
scripts/codex-review-report.sh "$run_id"        # the report (--wait blocks until done)
scripts/codex-review-converse.sh "$run_id" "Synthesize the security and perf findings; keep only likely true positives."
scripts/codex-review-list.sh 10
```

`converse` resumes the SAME review thread via `codex exec resume`, so follow-ups keep the reviewer's full context. Caveat that bites: a resumed review thread reasons about the commit state it originally reviewed. After you fix the code, do not ask the old thread to re-review; start a fresh `codex-review-start.sh --base ...` run.

Consuming a review: triage every finding by confirming it against the code before acting; a finding Codex labeled as an inference is not a fact. A finding you dismiss needs a stated reason, not silence, and the review is done when every finding is either fixed or explicitly dismissed. When writing custom instructions, scope the risk area but never state the answer you expect; a primed reviewer confirms instead of reviews.

## Exec workers (delegated implementation)

For a coordinator agent that schedules implementation work on Codex and needs to know, at any moment, whether the worker is actually working.

```bash
run_id=$(scripts/codex-exec-start.sh --workdir ~/repo --title "fix flaky retry test" \
  "Fix the flaky retry in src/client.ts so test/client.test.ts passes deterministically. Keep the diff scoped to that module. Do not run git commands." | awk '/^run_id:/{print $2}')

scripts/codex-watch.sh "$run_id" --json          # listen: one line per verdict transition, exit code = outcome
scripts/codex-status.sh "$run_id" --json         # or poll; works for ANY run kind, act on .verdict
scripts/codex-review-converse.sh "$run_id" "Also update the retry docs comment to match."   # resumes in the run's recorded workdir
scripts/codex-exec-stop.sh "$run_id"             # abort; partial work stays in the tree
```

The coordinator loop: start the worker, then either listen with `codex-watch.sh` or poll `codex-status.sh --json`, and branch on `verdict`. The verdict is multi-signal, not just "process exists": the status engine resolves the real codex process under the wrapper and probes `network_active` (established sockets) and `child_cmd_running` (a shell command executing), because codex emits no events while a command runs or while the model reasons server-side, so log silence alone cannot separate working from hung.

| verdict | meaning | coordinator action |
| --- | --- | --- |
| `running` | pid alive, session exists, events within the quiet window (180s, `--quiet-secs`) | keep waiting |
| `quiet` | silent past the quiet window but demonstrably active: an open API socket or a running command | healthy; a long command or server-side reasoning, check `last_event` |
| `wedged` | pid alive but no codex session within 180s (`--wedge-secs`): the startup hang | stop then relaunch; relaunch after a kill reliably works |
| `stalled` | the hang signature (silent + no socket + no running command), or log frozen past 1200s (`--stall-secs`) | read the log tail; stop and relaunch if truly hung |
| `dead` | meta says running but the process is gone and no report exists | read the log tail; relaunch if the task did not finish |
| `completed` / `failed` | terminal; `report_file` holds the final message | verify, then follow up or clean up |

Reconciliation: a gone process that DID leave a non-empty report is persisted as `completed`, not reported dead; this recovers orphaned runs whose wrapper died after the work finished (live-proven). When `lsof` is missing or errors, `network_active` reports `unknown` and the engine stays conservative: no early hang verdict on missing evidence.

Listening instead of polling: `codex-watch.sh <run_id> [--interval 15] [--json] [--timeout N] [--heartbeat]` prints one line per verdict transition and exits 0 on completed/stopped, 2 on failed, 3 on dead, 4 on its own timeout; `quiet` and `stalled` are announced but non-terminal. By default it is silent between transitions (right for monitors: no flooding, the exit code carries the outcome). Add `--heartbeat` when you want proof of pulling on every poll: each non-transition poll prints a line ending in `heartbeat` with `events=` and `log_idle=`, so progress is visible second by second; transition lines keep their format, so automation can still tell them apart.

Ground rules that make delegation work: one task per run with a concrete definition of done (follow-ups continue the same session via converse; unrelated work gets a fresh run). The launcher records `baseline_commit` and `baseline_dirty` in the run metadata automatically so the worker's diff stays separable; still do not touch the tree while it runs. The default `workspace-write` sandbox keeps `.git` read-only, so the worker cannot commit; collect and verify the diff yourself. `--network` enables fetches (new dependencies) inside the sandbox. And the worker's word is not the result: read the diff and run the tests before reporting it done.

One trap with a scar behind it: if the delegated task edits this skill's own scripts, supervise from a snapshot copy of the scripts, not the files being edited. A worker rewriting its own launcher/status/watch scripts crashes the wrapper and feeds the watcher half-written code; the run then looks dead while the real codex process works on. When a `dead` verdict arrives on such a task, check the raw codex process before believing it.

## MCP conversations

For dialogue rather than a one-shot report. `codex-mcp-start.sh` launches a persistent `codex mcp-server` (stdio JSON-RPC behind a FIFO) that survives across your shell calls; each `codex-mcp-send.sh` is one turn and prints the reply.

```bash
run_id=$(scripts/codex-mcp-start.sh --workdir ~/repo --sandbox read-only | awk '/^run_id:/{print $2}')

# Turn 1 opens a conversation thread (preset/model/config apply here):
scripts/codex-mcp-send.sh "$run_id" --preset adversarial \
  "Review the uncommitted diff. State your 3 strongest findings."

# Later turns continue the SAME thread with full context:
scripts/codex-mcp-send.sh "$run_id" "I disagree with finding 2 because the cap is enforced upstream. Defend it or drop it."
scripts/codex-mcp-send.sh "$run_id" "Given that, what is the single riskiest remaining issue?"

scripts/codex-mcp-status.sh "$run_id"    # server alive, thread, turn count, event tail
scripts/codex-mcp-stop.sh "$run_id"      # shut down; transcript stays on disk
```

Stop and delete are separate on purpose. Stop only ends the server process: the run stays in the list with status `stopped`, every transcript stays on disk, and the thread remains resumable via `codex exec resume`. Delete (`codex-delete.sh`) is the explicit removal step. And when you want to keep talking on the same live server but without the old history, send with `--new-thread`: same server, fresh conversation.

- First turn accepts `--preset`, `--model`, `--config k=v`; continuation turns accept only a prompt (that is what the `codex-reply` tool supports). `--new-thread` starts a fresh thread on the same server.
- Sandbox default is `read-only`: right for discussion and review. Use `--sandbox workspace-write` at start only when the conversation should let Codex edit files.
- Every turn is archived under the run's `conversations/turn-NNN-*.md`.
- `--timeout` defaults to 1800s per turn; on timeout the turn keeps running server-side and the reply stays retrievable from `server.jsonl` by request id.

Session continuation semantics (verified, the part everyone gets wrong): the MCP thread registry is per server process. While the server runs, every send continues the thread. Once the server stops, a NEW mcp-server cannot resume the thread (`Session not found`); the recovery path is `codex exec resume <thread_id> "<prompt>"`, which reloads it from `~/.codex/sessions` on disk. `codex-mcp-stop.sh` prints exactly this command, and `codex-mcp-send.sh` prints it when it finds the server dead.

## Deleting runs

```bash
scripts/codex-delete.sh <run_id> [run_id...]   # remove specific runs
scripts/codex-delete.sh --last                 # remove the newest run
scripts/codex-delete.sh --all                  # empty the store
```

Deletion removes the run directory (metadata, logs, report, archived turns). A run with a live process (an MCP server, or a review still running) is refused; stop it first or pass `--force`, which stops the process and then deletes. Deleting a run never deletes the codex thread itself: transcripts live in `~/.codex/sessions`, and the delete output prints the `codex exec resume <thread_id>` command while it still knows the id, so copy it if you may want the conversation back.

## Testing

```bash
tests/run-tests.sh --offline   # free: argument/error contracts, helpers, kind guards
tests/run-tests.sh             # full: every feature live against real codex
```

The live tier runs all three native review scopes (uncommitted with both runners, plus `--commit`) on a fixture repo with a planted bug and asserts the P0 rubric label plus prompt delivery, delegates a real implementation task to an exec worker with `--effort low` and polls its liveness verdict to completion including an observed `network_active: true`, proves MCP context continuity with a codeword (turn 1 stores it, turn 2 must recall it) and new-thread isolation (a fresh thread must NOT know it), exercises stop-keeps-session, delete, and the disk-resume recovery path. The offline tier unit-tests the whole verdict ladder as a pure function (every branch, including the unknown-network conservative rule), the activity prober, reconciliation of orphaned runs, and every guard/contract, using fabricated metadata with real pids. Run the offline tier after any script change; run the full tier before relying on a changed flow in a real campaign.

## Operational notes

- Run targeting is uniform across every command: pass an explicit `run_id`, or omit it (equivalently pass `--last`) to take the most recent run. Per-kind commands (`codex-review-*`, `codex-exec-*`, `codex-mcp-*`) default to the latest run OF THAT KIND; the universal tools (`codex-status`, `codex-watch`, `codex-delete`) and the shared continuation path (`codex-review-converse`, which serves review and exec follow-ups alike) default to the latest run of ANY kind. One resolver (`codex_resolve_run_id`) enforces this everywhere.
- Status has one shared engine: `codex-status.sh` works for any kind, and the per-kind `codex-{review,exec,mcp}-status.sh` add only kind guards, kind-scoped defaults, and kind-specific extras (review `--follow`, exec `baseline`, MCP `server_alive`/turn tail). The verdict computation and JSON shape are shared (`codex_emit_status`), so they cannot drift apart.
- Direct `codex review` is used for plain scoped reviews; `codex exec review` only when presets, custom prompts, model overrides, or reliable last-message capture require it. Follow-ups use `codex exec resume` because direct `codex resume` needs a TTY.
- Session tracking parses Codex output for the session id, falling back to watching `~/.codex/sessions/` for new files.
- One conversation turn at a time per MCP server; requests are id-sequenced through `meta.json` under a lock, but interleaved long turns confuse the humans reading the transcript more than they confuse the protocol.
- Quota is one shared window across all codex use. Serialize heavy runs; a failed run shows `failed` status with the error in its log.
