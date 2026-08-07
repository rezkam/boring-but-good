# Coordinator failure-mode taxonomy

Failure modes of a coordinator agent that plans work, dispatches subagents to implement and review it, and drives one
change set to review-ready. Each was confirmed by a human error-discovery review of real subagent-run records (one
record = the coordinator's dispatch prompt + the subagent's trace + the returned result + journal health). The fixes
below are the ones now encoded in the skill (`SKILL.md`, `dispatch.md`, `recovery.md`) and in the sibling `code-review/`
rubric. The review method and tooling are in this directory; the raw records are not published (they are local agent
transcripts, kept out of the repo by `.gitignore`).

## Confirmed failure modes

1. **prompt-interpolation-undefined.** A dispatch built its prompt from a template with an unset variable, shipping
   `cd undefined/<pkg>` and "worktree: undefined" to every agent in a workflow, under a header telling them to trust
   the environment facts as verified. One unchecked interpolation, workflow-wide blast radius. Fix: lint the RENDERED
   prompt before dispatch (reject `undefined`/`null`/empty interpolations); state the full resolved worktree path
   verbatim; an isolated worktree is mandatory. Corollary: an agent spending turns rediscovering environment facts the
   coordinator already holds is a dispatch defect, not agent initiative.

2. **severity-miscalibration-in-review.** Review agents grade runtime and data-integrity defects as lowest-severity
   because they feel edge-case (a client forwarding two flags a tool rejects together; a schema migration silently
   disabling a cache on a pre-existing database; an error masked by IO in a `finally` block; truncation splitting a
   surrogate pair; a filtered probability distribution left un-renormalized), pushing real bugs below the fix bar so
   they ship as tracked debt. Fix: a severity anchor in the rubric: interface/CLI-contract defects, runtime error
   paths, and silent data loss are High minimum, never Low.

3. **silent-death-retry-inheritance.** A subagent dies mid-run (connection closed after many edits); the runtime
   silently retries; the retry inherits the dead agent's uncommitted worktree edits with no provenance, and the
   coordinator sees nothing unless it reads the run journal. Fix: after every workflow, check the journal for
   `started` entries lacking a matching `result`; snapshot the worktree before each dispatch for attribution; make
   retries coordinator-owned and INFORMED (the retry is told it is a retry, given a distilled summary of what happened
   and the predecessor's transcript path, and continues rather than redoing, verifying inherited work as foreign code).

4. **schema-satisfied-with-junk.** An agent fills a closed report schema with placeholder values (every field set to
   "test"): validation-passing, information-free. Fix: report schemas are a minimal typed core plus a mandatory
   free-text what-changed narrative; placeholder-valued reports are a failed dispatch; the coordinator judges by disk
   regardless.

5. **structured-output-schema-abort.** An agent completes its real work, then exhausts its retries failing to satisfy
   a closed output schema (long-prose required fields), and the whole phase's output is discarded at the retry cap.
   Fix: verify/review/investigation agents return free text; schemas only for short factual cores.

6. **dispatch-lacks-role-framing.** Dispatches open with bare prohibitions (no git, no installs) instead of framing
   the relationship: you are a subagent; a coordinator reviews your work on disk and owns git and the change set; your
   goal is solely this one job. Fix: lead with the role; the prohibitions then read as consequences of it.

7. **dispatch-outsources-context-to-docs.** The dispatch requires the agent to go read a large plan or design document
   instead of inlining the distilled, task-scoped context (schemas, contracts, acceptance criteria). Fix: inline what
   the agent needs to DO the task; large docs are optional reference pointers only, since the coordinator owns the plan.

8. **ad-hoc-adversarial-definition.** Mid-loop verify dispatches improvise what "adversarial" means ("break the work")
   instead of invoking the canonical review kit. This is the root of both the severity miscalibration and undefined
   verdict vocabularies observed elsewhere. Fix: every adversarial dispatch invokes the shared kit; severity anchors
   and verdict definitions live once in the rubric, referenced everywhere.

9. **unadjudicated-agent-deviations.** An agent reports a deviation (work beyond or different from the dispatch, e.g.
   deleting extra test files) and the report is filed without the coordinator judging it. Fix: every reported
   deviation gets an explicit verdict before the slice closes: ratified (a good call, logged with why) or remediated
   (reverted or fixed via a follow-up dispatch).

## Long-session decay modes (from one very long campaign)

One session produced all five. They are grouped because they share a cause: every rule in this skill was prose, read
once, and nothing compared the rules to the calls. They are now refused at the tool boundary by `../guard/`, whose
codes map onto this list.

10. **pin-decay-over-session-length.** Pinning discipline present in hour one vanished by hour three and stayed gone
    for roughly seventy launches, every one inheriting the session's most expensive model at its highest effort; five
    later launches carried a bare model id that silently resolved to the builtin role's own `high` default. The audit
    script existed, ran six times in nineteen hours, and never after the fan-out that needed it. Fix: the routing row
    is a header on the dispatch itself (`ROUTE: key | class n | provider/model:effort | why`), and a launch without a
    valid pin or a matching header fails (CG002, CG003, CG004, CG012).

11. **builtin-role-substitution.** The harness's own role registry (`worker`, `reviewer`, `oracle`, `scout`, `commit`)
    silently replaced this skill's roles: zero dispatches rendered the implementer or reviewer template, prompts were
    hand-rolled without report path, status vocabulary, or escalation channel, and choosing a builtin role chose no
    model at all. Fix: builtin roles are transport for a rendered template, never a role; the harness `commit` builtin
    is on the never-dispatch list by name (CG007).

12. **review-loop-multiplication.** Twenty-three reviewers ran during implementation, one per parallel track, each
    rejection spawning a repair and each repair a re-review. Review became the bottleneck and the budget sink while the
    branch received nothing and the plan sat at seven of twenty-nine slices for five hours. Fix: reviewer dispatches
    before the single final pass are refused, whatever the prompt is labelled, and only one reviewer runs at a time
    (CG006).

13. **fan-out-without-integration.** Five writers launched in one instant across fifteen worktrees, with per-lane
    review and repair loops, and nothing integrated for hours. Parallelism became the product. Fix: at most three open
    writer lanes, where a returned lane stays open until the coordinator integrates it and runs its gates (CG010), and
    steering the same run a third time is refused in favour of stopping and splitting it (CG011).

14. **scope-change-becomes-shadow-campaign.** A one-line user request to adopt a newer dependency version was executed
    as an improvised eight-track parallel migration that appeared in no plan, and the user had to ask repeatedly why
    nothing was progressing and to say the existing plan should be followed. Fix: a mid-campaign instruction that
    changes the base, dependencies, or scope is a plan-reshaping stop condition: amend the plan, print the delta, then
    work it.

## Coordinator-side modes (from the same review, not per-record)

- **status-silence-at-peak-load.** Status blocks stopped entirely during the two hours of heaviest fan-out, and the
  blocks that were printed dropped the worktree and PR lines while using `DIRECT` for narration rather than
  non-dispatch justification. The user asked for status seven times. Fix: a launch behind a status block older than
  five minutes fails, the block's required fields are checked before it counts as fresh, and a turn that ends with
  lanes still open queues an automatic continuation (CG008).

- **over-asking-on-fix-scope.** Escalating confirmed-defect fixes that have an obvious conservative default, instead
  of fixing under the P0-P2 bar and logging a deviation. Fix: a narrower stop condition, so only plan-reshaping
  changes escalate.
- **happy-path-live-verify.** Accepting a live verification because the run went green, though the specific scenario
  the change targets never executed. Fix: a live-verify is done only when the target scenario provably executed;
  otherwise force the scenario or downgrade the assertion to "proven by deterministic test only" with the residual risk
  named.
- **redundant-live-runs.** Re-running expensive live jobs to reconfirm a property a deterministic test already proves,
  burning a shared provider quota. Fix: deterministic/isolating proofs are the default; live runs are budgeted; a
  provider-empty failure is classified and retried later, not blamed on code.

## Positive anchors (what a good dispatch/report looks like)

- A report shape the coordinator can interpret mechanically: a small typed core suited to the dispatch type (for an
  implementer: gates green?, in scope?, tests bite?, live-verify matches?, issues) plus a verified what-happened
  narrative, with the typed core kept suggestive rather than rigid so the workflow stays dynamic.
- Verify prompts that demand a concrete failure scenario per finding ("if you cannot construct one, it is a nitpick"),
  a severity scale, and a note on what held; and tests carrying a falsifiability demand ("report how the test fails if
  the logic breaks"), which produce genuinely non-hollow tests.
