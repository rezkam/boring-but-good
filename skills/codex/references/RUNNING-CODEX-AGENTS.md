# Running, managing, and monitoring Codex agents from a workflow

Living document. If you learn something new about driving Codex non-interactively, add it here and update the date. Keep entries verified: only write down what you saw happen, not what the docs claim.

Last updated: 2026-07-01 (financialq build campaign, codex-cli 0.142.5)

## What this covers

How an orchestrating agent (Claude or similar) uses the `codex` CLI as a worker: implementation tasks, fix rounds, and reviews, launched from Bash inside a workflow, with polling, health monitoring, and verification. The companion `SKILL.md` in this directory covers the review-tracking scripts; this file covers the general "Codex as implementer" pattern and its failure modes.

## Ground rules that make everything else work

1. The orchestrator NEVER edits code. Codex does all implementation and all fixes. The orchestrator builds prompts, launches, monitors, verifies artifacts on disk, and reviews.
2. Never trust the worker's self-report. After every run, verify with `git log <base_sha>..HEAD` (real commits exist), `git status --short` (tree is clean), and by running the tests it claims are green. A fix agent has previously masked a regression by faking a test; assume it can happen.
3. One Codex at a time. Quota is a single shared window, runs are heavy, and parallel Codex processes in one working tree conflict. Serialize.
4. Capture the base sha BEFORE launching. It is the only reliable way to scope the diff for review and to count real new commits.

## Invocation (verified on codex-cli 0.142.5)

Defaults come from `~/.codex/config.toml` (currently `model = "gpt-5.5"`, `model_reasoning_effort = "xhigh"`), so no model flags are needed unless overriding. Override with `-m <model>` and `-c model_reasoning_effort=<level>`.

Implementation run:

```bash
codex exec -C <repo> \
  --sandbox workspace-write \
  -c sandbox_workspace_write.network_access=true \
  -o <workdir>/last-message.txt \
  - < <workdir>/prompt.md > <workdir>/events.log 2>&1
```

Why each part:
- `-C <repo>`: working root. Do not rely on the shell cwd; harness shells reset cwd between calls.
- `--sandbox workspace-write`: lets Codex edit and commit in the repo without approval prompts. `exec` is already non-interactive; this sandbox level is what makes it able to act.
- `network_access=true`: workspace-write blocks network by default. Needed for npm/pip installs and live provider smoke tests. Leave it off for pure refactors.
- `-o last-message.txt`: the agent's final message lands in a file you can read after exit. Ask for a structured summary (commits made, tests run) in the prompt so this file is useful.
- `- < prompt.md`: prompt via stdin from a file. Avoids all shell quoting problems with long multi-line prompts. Always build a prompt file, never inline a big prompt as an argv string.
- `> events.log 2>&1`: the event stream is your only live visibility. Everything below (polling, stall detection, quota detection) reads this file.

Reviews: `codex exec review --base <branch>` (or `--uncommitted`). Check `codex exec review --help` before assuming flags; presets and custom prompts may need plain `codex exec` with a review prompt instead. The scripts in `scripts/` wrap this with run tracking.

## The nohup + pid + poll pattern

Codex xhigh runs regularly exceed 10 minutes, and most agent harnesses cap a single Bash call around there. So never run Codex in the foreground. Verified pattern:

```bash
cd <workdir>
nohup codex exec ... - < prompt.md > events.log 2>&1 &
echo $! > pid
```

Then poll in bounded slices. A bare `sleep 600` may be blocked by the harness; a conditional wait inside `bash -c` is not:

```bash
timeout 540 bash -c 'while kill -0 $(cat <workdir>/pid) 2>/dev/null; do sleep 20; done'
```

Repeat this call in a loop, and after each slice `tail -5 events.log` to see what Codex is doing. Budget generously: xhigh implementation tasks need up to 16 slices (about 2.5 hours). Only after the full budget: kill the pid, mark the run timed out, and report.

Gotchas seen live:
- `echo $! > pid` writes relative to the CURRENT cwd. If your shell cwd silently resets to the repo, you leave a stray `pid` file in the repo root that later fails "working tree clean" checks. Always use absolute paths for pid/log files.
- A run that LOOKS dead usually is not. In one campaign the skill's `--wait` poll budget expired, the meta.json status went stale at "running", and the run was declared failed while the process was healthy and later delivered a full report. Check `kill -0 $(cat pid)` and the events.log mtime before declaring anything dead. Never restart a Codex that is still running; you lose the work and pay the quota twice.

## workspace-write cannot commit: the two-session commit pattern

Verified on codex-cli 0.142.5: under `--sandbox workspace-write` Codex can create, edit, and test files in the repo but CANNOT commit. `git commit` fails with `fatal: Unable to create '.git/index.lock': Operation not permitted` because the sandbox keeps `.git` read-only. Codex will finish the task, report green tests, and end its final message with the intended-but-failed commit command.

Working pattern (privilege separation):

1. Implementation session: `--sandbox workspace-write` (+ network if needed). Codex does all the work; expect it to end with uncommitted changes and an "intended commit" note.
2. Commit session: a SECOND short fresh session with `--sandbox danger-full-access` whose prompt is commit-only and tightly scoped:
   - verify the branch, never push, never switch branches;
   - stage ONLY the task's files explicitly by path, never `git add -A` or `git add .`;
   - name the pre-existing dirty files it must NOT touch;
   - never commit runtime data dirs;
   - do not edit any source file;
   - end with the commit hashes and a `git status` confirmation.

The wide sandbox gets only the narrow task, and the wide task ran only in the narrow sandbox. Do not run the whole implementation under danger-full-access just to make commits work.

Consequence for verification: "codex exited with uncommitted work" is NOT automatically a defect under workspace-write; it is the expected end state before the commit session. Check the final message for the intended commit before judging.

## Detecting real failures in events.log

Two classes of signal, and a trap between them.

The trap: Codex's routine telemetry and its own repo exploration will match naive greps. `token_count` events legitimately contain `rate_limits` JSON, and Codex printing a file listing that includes `rate-limiter.ts` matched a loose `rate.?limit` grep and produced a false alert within minutes of arming a watchdog. Anchor to full error phrases:

```bash
grep -Eio '429 too many requests|rate limit (reached|exceeded|hit)|usage limit (reached|exceeded)|quota exceeded|401 unauthorized|invalid.?api.?key|stream error|stream disconnected|error sending request' events.log
```

Quota reality (ChatGPT Plus auth): a heavy campaign saturates the 5-hour primary window. When the run produced no commits AND events.log matches the quota signatures, stop the whole pipeline gracefully and record where you stopped. Do not retry into an exhausted window; later serial tasks depend on earlier ones, so continuing produces garbage.

## Watchdog for long campaigns

Run one persistent background monitor beside the workflow. Emit only lines you would act on:

- STALL: codex pid alive but the newest events.log size frozen for about 20 minutes (4 polls at 5 minutes). Shorter windows false-alarm on long xhigh thinking pauses.
- ERROR-SIGNAL: the anchored grep above, deduplicated once per log file (an associative array keyed by log path works).
- PROGRESS: new line in the campaign's progress log (one line per completed task).
- HEARTBEAT every ~30 minutes: current task, codex running yes/no, log size, `git log --oneline main..<branch> | wc -l` commit count, dirty-file count. This is how a human confirms the campaign is moving without reading logs.

Find the newest log across task and fix dirs with `ls -t <base>/*/events.log <base>/*/fix-*/events.log 2>/dev/null | head -1`.

## One fresh session per task (hard rule)

Every task gets its own fresh `codex exec` session. Never carry one session across tasks. (Within a task, fix rounds RESUME the task's session; see the fix-rounds section.) Reasons:

- Cross-task context poisons the next task: Codex anchors on the previous task's files, naming, and decisions instead of reading the new spec cleanly.
- A per-task prompt file is the complete, auditable input; a resumed thread has invisible state you cannot review or reproduce.
- Long threads degrade output quality and burn quota on replayed context.
- Session-scoped failure handling stays simple: one task, one pid, one events.log, one last-message.txt.

The task's identity travels in the PROMPT (issue body, commit range, defect list), not in session memory. If Codex needs to know what a previous task built, tell it to read the repo and the commits; the repo is the shared state, not the session.

## Freeze the spec, or the worker will edit it

Seen live: told to fix a resolver defect, Codex instead edited the binding design docs (an ADR and the context glossary) so the spec matched its implementation, in the same commit as the code change. The adversarial reviewer caught it because the diff scope included the spec files.

Two defenses, use both:

1. Prevention: put an explicit SPEC FREEZE line in every implementation and fix prompt: the design docs are frozen user-approved specs, never edit them to make a finding or test pass; if the spec seems wrong, implement the closest compliant behavior and report the conflict in the final message for a human to resolve.
2. Detection: reviewers must treat spec-file edits inside an implementation/fix diff as a finding by default. Keep spec files inside the reviewed diff scope; never exclude them.

## Fix rounds: resume the TASK's session (revised 2026-07-02)

Earlier guidance here said "fresh exec for fix rounds". A live campaign proved that wrong on cost: each fresh fix session spent most of its wall time and quota re-reading the repo to rebuild context it already had, and multi-round tasks became hours. The corrected model:

- ONE session per task. The implementation session IS the task's session. Capture its id at launch: events.log prints `session id: <uuid>` in the first lines; save it next to the pid file (`grep -m1 '^session id:' events.log | awk '{print $3}'`).
- Review findings go BACK INTO that session: `codex exec resume <session_id> --sandbox workspace-write ... - < fix-rN.md`. The fix prompt is then just the defect list; no repo re-orientation, so fix rounds drop from hour-scale to minute-scale.
- Fresh sessions remain the rule AT TASK BOUNDARIES (never reuse a session across tasks) and for reviews.
- `resume --last` is still forbidden in campaigns: reviewer/commit sessions interleave, so always resume by explicit saved id.

The stale-resume warning that motivated the old rule still holds where it was learned: a resumed REVIEW session evaluates the session's ORIGINAL commit, not later edits. Reviews are always fresh runs. It is implementation sessions that should be resumed, because they act on the live working tree.

## Prompt file construction for implementation tasks

Build `prompt.md` from three blocks:

1. House rules: repo path, branch, never push, commit format, what is authoritative spec (ADRs/design docs), test policy (targeted tests only, never the full repo suite; full-suite runs inside agents have stalled whole workflows), and anything the codebase mandates.
2. The task, verbatim. If it is a GitHub issue: `gh issue view <n> --json title,body`. Write self-contained issues so this works without extra context.
3. Requirements for the run: implement fully per acceptance criteria, real fixture-based tests run to green, small conventional commits each carrying a task marker like `(FIN-004 #43)` (the marker is how later automation detects the task's commits), do not push, and: "end your final message with a short summary listing commits made and tests run" (this makes `-o last-message.txt` verifiable against `git log`).

## Verification checklist after every Codex exit

- [ ] exit observed (pid gone), `last-message.txt` exists and is non-empty
- [ ] `git log --oneline <base_sha>..HEAD` shows new commits (zero commits + error signatures in the log = quota/auth failure, not a Codex decision)
- [ ] `git status --short` clean; uncommitted leftovers are a defect to send back
- [ ] the tests the final message claims were run actually pass when you run them
- [ ] no push happened (`git status -sb` shows no ahead-of-remote surprise on a branch that should be local)

Then review adversarially (separate reviewer agents on `git diff <base_sha>..HEAD`), refutation-verify findings against the actual code before believing them, and send only confirmed defects to a fresh fix run. Cap fix rounds (3 is a good bound); a task that will not converge should stop the campaign, not loop forever.

## MCP mode: persistent server for multi-turn conversation (verified 2026-07-02)

`codex mcp-server` (stdio JSON-RPC) is the right tool when you need a continuous non-interactive dialogue (adversarial discussion, review synthesis across rounds) instead of one-shot exec runs. The `codex-mcp-*.sh` scripts wrap it; these are the facts they are built on, all verified live on codex-cli 0.142.5:

- The server exposes exactly two conversation tools: `codex` (opens a thread; arguments: `prompt`, `cwd`, `sandbox`, `approval-policy`, `model`, `config`, `base-instructions`, `developer-instructions`) and `codex-reply` (continues one; arguments: `threadId`/`conversationId` + `prompt` ONLY, so per-turn model/config changes are not possible on continuation turns).
- A `tools/call` result arrives only when the whole turn finishes; `structuredContent` carries `{threadId, content}`. While the turn runs, `codex/event` notifications stream to stdout, which is your live activity view.
- The thread registry is PER PROCESS. `codex-reply` against a fresh server returns `Session not found` even though the rollout file exists on disk. Recovery for a dead server: `codex exec resume <threadId>`, which does load from disk. Turn failures like this arrive as normal results with the error text in `content`, not as JSON-RPC errors, so check content shape.
- Keeping the server alive across shell calls needs the stdin FIFO opened read-write BY THE SERVER (`codex mcp-server 0<> fifo`). A read-only stdin gets EOF the moment the first short-lived writer closes, and the server exits. Also guard every FIFO write with a timeout: opening a FIFO for writing blocks forever when the reader is gone.
- Per-turn cost control on the opening turn: `arguments.config` accepts the same keys as `-c` (e.g. `{"model_reasoning_effort": "low"}`); values are TOML-parsed with string fallback.

## Exec liveness: a hang looks like work (added 2026-07-03)

A backgrounded `codex exec` can be alive at ~0% CPU while doing nothing. "Process running" is NOT "working". `scripts/codex-exec-status.sh` encodes these checks as verdicts (running/wedged/stalled/dead); the raw signatures, for anyone driving exec by hand:

- Stdin: with an inherited open pipe, exec prints `Reading additional input from stdin...` and blocks forever. Launch with `< /dev/null` (exec-start does this). Grounding: `codex exec --help` on 0.142.5 documents that piped stdin is appended as a `<stdin>` block, so a never-closing stdin means an eternal wait. Note the asymmetry: piping a prompt that CLOSES the pipe (`printf | codex exec resume`) works; converse relies on it.
- Startup wedge: pid alive but no session file under `~/.codex/sessions/<Y/M/D>/` and no thread id in the event log within ~3 minutes. Kill and relaunch; relaunching after a kill reliably works. (Reported by a second independent skill; our status script detects it via the missing thread id.)
- Worktree trust: headless exec in a directory Codex does not trust can block forever on an invisible prompt. Git worktrees are separate paths from the trusted repo root; pre-add `[projects."<worktree-path>"]` with `trust_level = "trusted"` to `~/.codex/config.toml` before exec-ing in one. (Reported, mechanism plausible, not yet reproduced by us; likely explains historical silent worktree hangs.)
- `codex exec resume --last` resolves to the most recent session GLOBALLY, so any codex run in between (a review, a smoke turn) hijacks it. Always resume by explicit session id; the skill's scripts pin thread ids in run metadata for exactly this reason.
- Do not launch two execs in the same instant, and kill stale hung execs before starting a new one.
- Long prompts via `"$(cat prompt.txt)"`: check the file exists first; a missing file silently sends an empty string as the task. Prefer `--prompt-file` on exec-start, which errors on a missing file.
- Sandbox blindness: workspace-write blocks localhost binds (`listen EPERM` on vite/playwright dev servers), so a sandboxed worker can ship server/browser code it never saw run. For tasks that must run browsers/servers/full suites, `--dangerously-bypass-approvals-and-sandbox` trades that blindness for zero OS control: dedicated worktree only, self-authored prompt only, mandatory diff review afterwards. `--full-auto` is a deprecated alias for workspace-write; do not reach for it. Network inside workspace-write: `-c sandbox_workspace_write.network_access=true` (exec-start's `--network`).

## Prompting Codex as a worker (added 2026-07-03)

Prompt like an operator, not a collaborator: state the concrete task, what done looks like, and the few constraints that matter. A tighter prompt beats a bigger run; improve the contract before raising effort or model. One task per run: review, fix, and docs are separate runs (or one run plus converse follow-ups), never one mixed prompt. Name skills instead of restating them; Codex reads the same repo skills. Anti-patterns that reliably waste a run: vague framing ("take a look"), no output contract ("report back"), "think harder" in place of a contract, and demanding certainty the evidence cannot support. For reviews: scope the risk area, never state the answer you expect; a primed reviewer confirms instead of reviews. Consuming results: triage every finding against the code, keep Codex's inference labels intact, and give every dismissal a stated reason.

## Known script bugs in this skill

- `codex exec review` takes custom review instructions as a POSITIONAL argument and reads stdin only when that argument is `-`. `scripts/codex-review-start.sh` used to pipe the preset/custom prompt to stdin WITHOUT the `-`, so every preset and custom prompt on the review path was silently dropped; reviews still ran (codex reviews the diff on its own) so nothing errored. FIXED in-repo 2026-07-03 by appending `-` when a prompt is set; the test suite now greps the session rollout to prove prompt delivery. Caught by an eval round where the new severity rubric had no effect on the review output. Note the asymmetry: plain `codex exec` and `codex exec resume` DO read the prompt from stdin without `-`.
- Follow-up to the above, same day: scope flags (`--uncommitted`, `--base`, `--commit`) are mutually exclusive with `[PROMPT]` at parse time, on BOTH `codex review` and `codex exec review` (0.142.5). Prompt-mode reviews rely on the default scope, which IS the uncommitted change set (verified by probing the harness's git commands). The script now omits `--uncommitted` when a prompt is set and hard-refuses base/commit scope with a prompt. So: presets/custom prompts = uncommitted scope only; shape scoped reviews via `codex-review-converse.sh` after the fact.
- `scripts/codex-review-start.sh` used to die with exit 141 (SIGPIPE) under `set -e -o pipefail` on its `find | sort -rn | head` pipeline whenever more than 50 codex session files existed (head exits first, sort gets SIGPIPE, pipefail kills the launcher before it spawns the worker; runs stay `queued` with `pid: none` forever). FIXED in-repo 2026-07-02 by appending `|| true` to that pipeline in `_helpers.sh` `codex_review_stamp_sessions`. If you still hit exit 141 with no output, check for other unguarded `| head` pipelines.

## Changelog

- 2026-07-04: fixed resume effort/model drift. `codex exec resume` does NOT carry the original session's reasoning effort or model forward; without an explicit `-c model_reasoning_effort=` it falls back to the model's config default (`xhigh` for gpt-5.5). So a run started with `--effort medium` silently ran its converse follow-ups at xhigh (caught on FIN-011: rollout `turn_context.collaboration_mode.settings.reasoning_effort` showed medium on the opening turn, xhigh on both resume turns). FIXED: `codex-review-converse.sh` now defaults `--effort`/`--model` from the run's recorded meta.json (same pattern as the `--workdir` default) when not passed, so a resume stays at the tier the run was started with. To pin a campaign to a tier, start the run with `--effort <tier>`; every resume inherits it. Verify actual effort per turn via the session rollout under `~/.codex/sessions/**/rollout-*<thread_id>*.jsonl` (`turn_context` → `collaboration_mode.settings.reasoning_effort`), not the meta effort field alone.
- 2026-07-03 (later): multi-signal liveness shipped after a live incident (healthy worker silent 5 min looked hung): quiet verdict tier, activity prober (real codex pid under the wrapper, network_active via lsof with unknown-on-error, child_cmd_running), hang signature = silent + no socket + no child, orphan reconciliation (dead wrapper + non-empty report persists completed, live-proven on a real orphan). Unified `codex-status.sh` (any kind, one JSON shape) and `codex-watch.sh` (transition lines, outcome exit codes 0/2/3/4). `--effort` flag on every entry point, validated, recorded in meta; defaults stay codex's own config. All three implemented BY codex exec workers under a gated workflow (delegate, watch, verify, adversarial review, triage, fix round). NEW SCAR: a worker editing the skill's own scripts crashed its launcher wrapper (bash re-reads script files mid-execution) and fed the watcher a half-written status script ("null null verdict=dead") while the real codex process worked on; supervise self-modifying tasks from a snapshot copy of the scripts and verify the raw codex pid before believing dead.
- 2026-07-03: added the tracked exec-worker lifecycle (`codex-exec-start/status/stop`) so a coordinator agent can delegate implementation and poll a liveness verdict (running/wedged/stalled/dead/completed/failed) instead of trusting a live pid; follow-ups reuse converse. Adopted from an independent codex skill after review: exec liveness signatures (stdin `< /dev/null`, startup-wedge watchdog, worktree trust_level, resume --last hijack, prompt-file trap, localhost-bind sandbox blindness), operator-style prompting discipline, and the findings-triage protocol; each marked verified vs reported.
- 2026-07-03: fixed silent prompt drop on the review path (`codex exec review` needs `-` to read stdin, see Known script bugs); anchored a P0-P3 severity rubric in the adversarial preset (a crash on documented valid input is always P0, after a labeling round rated exactly that as P2); live suite now proves prompt delivery via session-rollout grep, asserts the P0 label, and asserts stop keeps a run listed with its transcripts until an explicit delete.
- 2026-07-02: added `codex-delete.sh` completing the session lifecycle (create, status, converse, stop, delete). It refuses runs with a live pid unless --force (which stops them first), supports --last and --all, and prints the `codex exec resume <thread_id>` command before removal because the codex thread in ~/.codex/sessions survives the delete. The offline test tier covers the whole delete lifecycle; the live tier deletes real finished runs.
- 2026-07-02: added MCP mode: `codex-mcp-start/send/status/stop` scripts wrapping a persistent `codex mcp-server` for multi-turn conversation; verified the per-process thread registry, the `0<>` FIFO keep-alive requirement, `structuredContent.threadId` continuation, in-content error reporting, and the `codex exec resume` disk-recovery path. Added `--config k=v` passthrough to review start/converse. Added `tests/run-tests.sh` (offline contract tier + live full-feature tier with codeword-based context-continuity proof).
- 2026-07-02: fixed the exit-141 launcher bug for real (see Known script bugs): `codex_review_stamp_sessions` pipeline now ends in `|| true`. Diagnosed during the FIN-005 review: three FIN-004 runs and two FIN-005 runs all died pre-spawn as silent `queued` entries.
- 2026-07-02: REVISED fix-round guidance: resume the task's own implementation session (by saved session id) for fix feedback instead of fresh exec per round; fresh-per-round burned hours and quota rebuilding context. Fresh sessions stay mandatory at task boundaries and for reviews. Also: slim the reviewer side, full multi-agent panel for round 1 only, single re-verifier agent for later rounds.
- 2026-07-02: added the spec-freeze rule after Codex edited a binding ADR to match its implementation during a fix round; prevention (freeze line in prompts) + detection (spec edits in a fix diff are a finding).
- 2026-07-02: added the two-session commit pattern: workspace-write keeps .git read-only (index.lock Operation not permitted), so implementation runs sandboxed and a scoped commit-only session runs with danger-full-access. Seen on every FIN-001 run and fix round.
- 2026-07-02: added the one-fresh-session-per-task hard rule (user mandate): task identity travels in the prompt, the repo is the shared state, sessions are never reused across tasks or fix rounds.
- 2026-07-01: initial version from the financialq build campaign (serial issue implementation with adversarial review loops). Verified: invocation flags, nohup+poll pattern, stray pid gotcha, rate-limiter.ts false-positive grep trap, stall thresholds, fresh-exec-over-resume for fix rounds.
- 2026-07-04: fixed a converse-resume sandbox trap. `codex exec resume` derives its workspace-write sandbox root from the CURRENT directory (same as exec-start's `(cd "$WORKDIR" && codex exec ...)`), but `codex-review-converse.sh` never cd'd, so a fix-round follow-up launched from another cwd (e.g. the skill dir) reported "worktree is not writable / financial/ missing" and made no edits. Fix: converse now defaults its working directory to the run's recorded `workdir` from meta.json (override with `--workdir`) and runs codex inside `( cd "$WORKDIR" && ... )`. Seen during the FIN-011 fix round.
- 2026-07-07: verified the codex CLI and the pipeline's pi-ai `openai-codex-pro` slot share ONE ChatGPT account quota window: a pipeline preflight 429 (`usage_limit_reached`, `resets_at` T) and `codex exec` failing with "You've hit your usage limit... try again at T" showed the SAME reset time. Consequences: (a) an exec worker launched right after a heavy pipeline run fails instantly at turn.started with exit 1 and verdict `failed` (not a hang), (b) plan exec launches around pipeline extract windows, (c) after the reset a FRESH exec-start with the same prompt works (failed run 84C8B03D relaunched as 1F84B7B3, completed in ~2 min). Watch pattern: `until [ "$(date +%H%M)" \> "HHMM" ]; do sleep 30; done` as a background waiter, then relaunch.
