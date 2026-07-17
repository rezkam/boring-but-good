# Dispatch

What every dispatch must establish, and who runs on what. The wording is yours: a dispatch succeeds when the subagent can do its one job without rediscovering anything you already knew, and its report can be verified without trusting it.

## Model and effort matrix

| Role         | Model                        | Effort                        | Used for                                                 |
| ------------ | ---------------------------- | ----------------------------- | -------------------------------------------------------- |
| Investigator | one tier below coordinator   | low; medium for tangled areas | read-only questions before or during the plan            |
| Implementer  | one tier below coordinator   | high                          | landing one slice                                        |
| Fixer        | one tier below coordinator   | medium                        | one confirmed finding, evidence attached                 |
| Reviewer     | top tier (coordinator's own) | high                          | one adversarial pass over the whole diff, fresh context  |

Effort is set by the dispatch mechanism, and mechanisms differ in whether they expose it. A workflow-style dispatcher that takes an `effort` option, or a custom agent definition that carries an effort setting, can pin it. A bare subagent-spawn tool that exposes no effort control leaves effort inherited from the caller and unverifiable after the fact. So for effort-sensitive work, route through a mechanism that pins effort; if the only tool at hand cannot, do not assume the requested effort took: say it is inherited and fall back to encoding the expected depth in the prompt as a last resort. Likewise verify the model a dispatched agent actually ran on (the served model is usually recorded in its transcript or task metadata) rather than assuming the requested model took.

## Mechanism facts

- A long serial slice chain suits a Workflow script: one `agent()` per slice gives resume-from-cache on a killed run. Report schemas, when used, are a MINIMAL typed core per dispatch type (impl/fix: gates green?, in scope?, tests bite?, live-verify matches?, issues) plus a mandatory free-text what-changed narrative; never put long prose in required schema fields (oversized results hit the structured-output retry cap and abort completed work), and never accept placeholder values ("test", empty strings) as a report: a schema-valid but information-free report is a FAILED dispatch, re-dispatched or verified from disk. Verify/review/investigation agents return free text, always. Keep the per-type cores suggestive, not rigid: the workflow stays dynamic.
- Single dispatches suit the Agent tool in background mode; SendMessage continues an agent with its context intact.
- An investigator that already mapped a slice's ground can be continued as that slice's implementer. The context it built is capital; spend it instead of rebuilding it in a cold agent.

## Lanes

The default implementer is a subagent one model tier below the coordinator. When a standing project rule routes implementation elsewhere (for example "codex does all impl and fixes"), the implementer dispatch becomes a driver for that worker: same contract, same report. A worker that cannot commit reports its diff and the coordinator commits it after verifying. The driver drives; when the worker fails, it reports the failure instead of editing code itself.

## Every dispatch establishes

- the role, first: it is a subagent; a coordinator agent reviews its work on disk, owns git (commit/push), the living docs, and the campaign; its goal is solely its one job and an honest report. Prohibitions (no git, no live runs, no installs) then read as consequences of the role, not an arbitrary rule list
- one job (a subagent given two jobs does both halfway)
- the whole world, distilled and inline: FULL resolved absolute paths (the worktree path verbatim, never a variable), working directory and branch verified by the subagent before it changes anything, the task-scoped context the agent needs to DO the job (schemas, contracts, acceptance criteria, file anchors) inlined in the prompt, and the ENVIRONMENT FACTS: the traps you proved during setup, stated as verified facts with hard boundaries (baseline counts, install traps, scratch-vs-live data paths, signing fallbacks). Large plan or design documents are optional reference pointers, never required reading: the coordinator owns the plan and distills it. The completeness bar: the agent's first tool call should be task work, not environment discovery
- git boundaries: implementers and fixers commit locally with conventional messages; only the coordinator pushes
- the report contract below

## Pre-dispatch checks

- Lint the RENDERED prompt before dispatch: reject `undefined`, `null`, `NaN`, and empty interpolations (one unset template variable once shipped `cd undefined/<pkg>` to every agent in a workflow, under a "trust these, verified" header). Build prompt bodies from plain quoted strings; no backticks inside prompt text when the dispatch mechanism parses the script.
- Snapshot the worktree (`git status --short` plus `git diff --stat`) immediately before every implementer or fixer dispatch and record it in the notes: it is the baseline for attributing partial state after a death, retry, or interrupted run.
- After a workflow returns, read its journal: `started` without `result` = a dead (possibly silently retried) agent; handle per [recovery.md](recovery.md) before trusting any report.

## The implementer's contract

An implementer knows, before it starts:

- the slice: acceptance criteria stated as observable behavior, file anchors, pre-verified facts about the data, and verify commands with expected outputs
- scope is the slice, and the deviation clause verbatim: "If you hit an edge case that forces you to deviate from the plan, pick the conservative option, log it under 'Deviations', and keep going."
- re-entry is idempotent: the campaign can resume, so work already landed is confirmed green and reported with its commit, never redone
- tests are real: tdd where the behavior is testable; a test that guards a fix is proven to bite (revert the change, watch it fail, restore, watch it pass); a skipped or tautological test is a defect
- the spec is authoritative: an acceptance threshold that fails on real data is reported with the measured value and logged as a deviation, never tuned green
- gates before commit are typecheck plus the touched test files; the full suite belongs to the coordinator
- the notes protocol: a Slice log entry with evidence, earlier entries left as written; the file is the user's local record and never gets staged or committed

## The fixer's contract

Everything above, narrowed to confirmed findings only: each finding arrives with its evidence (the failing command and verbatim output) and the expected post-fix output. A fixer taking over partial work judges the tree first (status and diff) and either builds on it or redoes it coherently.

## The investigator's contract

Read-only, one question. The answer carries file:line evidence, separates observed code from documented aspiration and observation from inference, and names any part of the question the repo cannot answer.

## The reviewer's contract

The reviewer runs the adversarial methodology in the sibling `code-review/` kit (`ADVERSARIAL_CODE_REVIEW_PROMPT.md`) itself, finders and refutation in one agent, review depth thorough: its job is to break the work, and everything it is given is verifiable on disk (verify, do not trust). It is asked to focus on the most important issues and problems, with severity, confidence, and what is worth reporting governed by the guide's rubric: trust over volume.

The same holds for every adversarial verify dispatch mid-loop, not only the review rounds: "adversarial" is defined by the canonical kit (`ADVERSARIAL_CODE_REVIEW_PROMPT.md`; `RUBRIC.md` for severity anchors, confidence, false-positive filters, and report thresholds; `REFUTER_PROMPT.md` for refute passes), never improvised per dispatch. The dispatch states what each verdict means and its threshold (for example CLEAN/SHIP = zero confirmed findings above the fix bar remaining; NEEDS-FIX/BLOCK = at least one confirmed finding above the bar with file:line evidence). Severity anchor that binds every reviewer: defects in public interfaces or CLI/tool contracts, runtime error paths, and silent data loss or truncation sit ABOVE the tracked-debt line (High/P2 minimum), regardless of how edge-case the trigger feels.

It receives:

- the guide's inputs: repository root (the worktree), change scope (the base..head diff, head pinned), the goal, and the validation commands
- campaign context the guide cannot know: the commit-to-slice map, the scope rule for deferred slices (their absence is not a defect; committed code silently depending on them is), and the ENVIRONMENT FACTS
- on rounds after the first: the prior round's findings and their fix commits, so each fix is judged as new work, since a partial fix is a new finding

Campaign duties on top of the guide: acceptance per slice with each live-verify reproduced and its actual output quoted; gates re-run fresh with counts quoted; the hollow-test hunt; on every "done" claim the three checks (defined in a doc vs enforced by a failing test, written vs actually read downstream, referenced vs executable end-to-end); cross-slice seams; and the deviations audit.

Its report: verdict SHIP / SHIP WITH FIXES / BLOCK with the head SHA the verdict covers; findings ranked most severe first, each as file:line, severity, the defect in one sentence, the concrete failure scenario, and the verification evidence (command plus output snippet); observed facts separated from inference; categories with no findings declared as such.

## The report contract (implementers and fixers)

A report proves, compactly (outcome lines and short snippets, never pasted logs):

1. what changed, at behavior level
2. status per acceptance criterion
3. live-verify: the exact commands run plus the observed output proving each acceptance
4. what was observed vs what is inferred, separated
5. deviations (or "none")
6. what remains unverified
7. deviations are not just listed: each one is input to the coordinator's adjudication (ratified or remediated) before the slice closes

A report missing its evidence is unverifiable and goes back.
