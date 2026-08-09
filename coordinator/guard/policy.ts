/**
 * Coordinator guard policy: harness-agnostic rules, pure functions only.
 *
 * Every rule here exists because a real campaign broke it while the skill text said not to.
 * Prose asks; this refuses. Each denial names the exact unblock action, so a blocked call is
 * one corrected retry away rather than a stall.
 *
 * Evaluation runs in two phases, and the split is the point:
 *
 * - `evaluateStructure` decides everything that is a fact about the call: is a model pinned,
 *   does the class match the tier table, is there a budget key, is the lane cap full, is the
 *   status block stale. No model call, no reading of prose.
 * - `evaluateVerdicts` decides everything that depends on what a prompt *says*, using the
 *   judge's structured answers as evidence. The decisions stay here; only the reading moves.
 *
 * Reading intent with regexes was tried first and failed: six review rounds were spent on it,
 * and two of them broke on this guard's own vocabulary. See judge.ts.
 */

import type { DescribedScope, JudgedKind, PromptVerdict } from "./judge.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ImplementationClass = 1 | 2 | 3;
export type LaneKind = "implement" | "review" | "investigate";
export type LaneState = "running" | "returned" | "integrated";

export interface GuardConfig {
	statusMaxAgeMs: number;
	laneCap: number;
	steerCap: number;
}

export const DEFAULT_CONFIG: GuardConfig = {
	statusMaxAgeMs: 5 * 60_000,
	laneCap: 3,
	steerCap: 2,
};

export interface Lane {
	key: string;
	kind: LaneKind;
	model: string;
	runId?: string;
	startedAt: number;
	state: LaneState;
	/** What the coordinator recorded when the lane returned, replayed if it tries to redispatch. */
	note?: string;
}

export interface Campaign {
	version: 1;
	slug: string;
	worktree: string;
	planPath: string | null;
	authorized: string;
	status: "active" | "review" | "closed";
	slicesTotal: number;
	slicesDone: number;
	lanes: Lane[];
	routes: RouteHeader[];
	steers: Record<string, number>;
	/** Capabilities the user granted by name, kept structured so a refusal can check them. */
	grants?: { forcePush?: string[] };
	lastStatusAt: number | null;
	/** Why the most recent block was not counted, so the refusal can say it instead of guessing. */
	lastStatusProblem?: string | null;
	startedAt: number;
}

export interface RouteHeader {
	key: string;
	/** Which table the number belongs to: implementation classes or review classes. */
	axis: "class" | "review";
	/** 1, 2, or 3 for the implementation axis; 1 or 2 for review. Kept finite so a parsed
	 * route stays assignable where an implementation class is required. */
	cls: ImplementationClass;
	model: string;
	reason: string;
}

export interface GuardRequest {
	tool: string;
	input: Record<string, unknown>;
	now: number;
	armed: boolean;
	campaign: Campaign | null;
	config?: GuardConfig;
	/** The effective tier lists, defaulting to DEFAULT_TIERS when the user has set none. */
	tiers?: TierLists;
}

/** Which entry a dispatch took, when it was not the class's first. */
function fallbackUsed(
	target: JudgeTarget,
	kind: JudgedKind,
	tiers: TierLists,
): { used: string; preferred: string; axis: "class" | "review"; cls: number } | null {
	const pin = parseModelPin(target.model);
	if (!pin) return null;
	const axis: "class" | "review" = kind === "review" ? "review" : "class";
	// The review axis has two classes, so a declared 3 belongs to no review list at all.
	const entries =
		axis === "review"
			? target.declaredClass === 3
				? undefined
				: tiers.review[target.declaredClass]
			: tiers.class[target.declaredClass];
	if (!entries || entries.length < 2) return null;
	const index = entries.findIndex((entry: string) => entryMatches(entry, pin));
	if (index <= 0) return null;
	return { used: entries[index], preferred: entries[0], axis, cls: target.declaredClass };
}

/** The denial half, so a refusal stays assignable wherever a richer allow shape is expected. */
export type GuardDenial = { allow: false; code: string; reason: string; teach?: boolean };
export type GuardDecision = { allow: true } | GuardDenial;

const STATUS_FIELDS = ["CAMPAIGN", "WORKTREE", "SLICES", "PR", "AGENTS", "DIRECT", "PARKED", "NEEDS YOU", "NEXT"] as const;

/** Actions that only inspect or control existing runs. Anything else carrying work is a launch. */
const MANAGEMENT_ACTIONS = new Set([
	"list",
	"get",
	"status",
	"models",
	"steer",
	"stop",
	"interrupt",
	"resume",
	"pending",
	"reply",
	"send",
	"ask",
	"transcript",
	"view",
	"fleet",
	"cancel",
	"watchdog.recommend-model",
	"watchdog.status",
]);

/** Actions that hand a run another instruction, and so count as corrections of it. */
const CORRECTION_ACTIONS = new Set(["steer", "resume"]);

const COORDINATOR_OWNED_AGENTS = new Set(["commit", "committer", "pr", "release"]);

export function newCampaign(init: {
	slug: string;
	worktree: string;
	planPath?: string | null;
	slicesTotal: number;
	authorized: string;
	startedAt: number;
}): Campaign {
	return {
		version: 1,
		slug: init.slug,
		worktree: init.worktree,
		planPath: init.planPath ?? null,
		authorized: init.authorized,
		status: "active",
		slicesTotal: init.slicesTotal,
		slicesDone: 0,
		lanes: [],
		routes: [],
		steers: {},
		lastStatusAt: init.startedAt,
		lastStatusProblem: null,
		startedAt: init.startedAt,
	};
}

/** How many consecutive errored turns a campaign tolerates before it stops continuing itself. */
export const MAX_CONSECUTIVE_ERRORS = 3;

/**
 * Whether the campaign should continue itself after a turn ends.
 *
 * The campaign is the goal, and a goal that parks itself on the first transport error ends
 * the unattended run it exists to carry. A provider failure is not a decision, so it is
 * retried; a deliberate abort is a decision, so it stops. Repeated failures stop too,
 * because continuing into a provider that keeps refusing is not progress.
 */
export function continuationDecision(
	campaign: Campaign,
	turn: { stopReason?: string; consecutiveErrors: number },
): { proceed: boolean; reason?: string } {
	if (campaign.status === "closed") return { proceed: false, reason: "the campaign is closed" };
	// Deciding this here rather than at the call site is the point: the caller continued only
	// while a lane was open, so a campaign between dispatches had nothing carrying it.
	const open = campaign.lanes.filter((lane) => lane.state !== "integrated");
	if (open.length === 0 && campaign.slicesDone >= campaign.slicesTotal) {
		return { proceed: false, reason: "every slice is recorded done and no lane is open" };
	}
	if (turn.stopReason === "aborted") return { proceed: false, reason: "the turn was aborted, which is a decision rather than a failure" };
	if (turn.stopReason === "error") {
		if (turn.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
			return { proceed: false, reason: `${turn.consecutiveErrors} consecutive turns ended in an error, so the provider is failing rather than the campaign progressing` };
		}
		return { proceed: true, reason: `turn ${turn.consecutiveErrors} of ${MAX_CONSECUTIVE_ERRORS} after a provider error` };
	}
	return { proceed: true };
}

/** What an integrated writer lane did to the slice ledger. */
export type SliceOutcome = "done" | "retry" | "partial";

/**
 * Record an integration against the slice count, in the same call that records the lane.
 *
 * These were two tools. The writer cap forces the integration call, because an open lane
 * holds capacity, but nothing forced the separate set-slices, so one campaign integrated 42
 * lanes, called set-slices 14 times, and froze at 18 of 31 for twelve hours while the work
 * carried on. Review never opens at 18 of 31, and the ledger cross-check then makes an
 * honest status block the refusable one, so the campaign cannot finish or tell the truth.
 *
 * A lane name cannot answer this: task-3-gate-r3 is a re-run of a slice already counted, and
 * only the coordinator knows that. So the caller states the outcome and the guard counts it.
 */
export function recordIntegration(campaign: Campaign, outcome: SliceOutcome): Campaign {
	if (outcome !== "done") return campaign;
	return { ...campaign, slicesDone: Math.min(campaign.slicesTotal, campaign.slicesDone + 1) };
}

/**
 * Widen a campaign's recorded scope, appending rather than replacing.
 *
 * The grant was fixed at start, so an approval the owner gave in chat could not be recorded.
 * A coordinator with a just-approved force-push in front of it found the only door open to
 * it was closing the campaign and starting a continuation, which discards the ledger review
 * opens on. Appending keeps the original grant readable next to what was added to it.
 */
export function amendAuthorization(campaign: Campaign, addition: string): Campaign {
	const extra = addition.trim();
	if (!extra) return campaign;
	return { ...campaign, authorized: `${campaign.authorized}; ${extra}` };
}

/**
 * Grant a force push on one exact branch.
 *
 * Kept as a branch list rather than read out of the authorization prose, because deciding
 * whether a sentence permits rewriting published history is exactly the judgement this
 * guard refuses to make with a regex. The user names the branch; the guard compares
 * strings.
 */
export function grantForcePush(campaign: Campaign, branch: string): Campaign {
	const name = branch.trim().replace(/^refs\/heads\//, "");
	if (!name) return campaign;
	const current = campaign.grants?.forcePush ?? [];
	if (current.includes(name)) return campaign;
	return { ...campaign, grants: { ...campaign.grants, forcePush: [...current, name] } };
}

/**
 * The branches a push command would write, as written on the command line.
 *
 * Returns null when the destinations cannot be read, which is treated as ungranted: a push
 * whose targets are unclear is not a push that was approved.
 */
export function forcePushTargets(command: string): string[] | null {
	const match = /(?:^|[\s;&|(])git(?:\s+(?:-[cC]\s+\S+|--\S+|-[^-\s]\S*))*\s+push\s+([^;&|]*)/i.exec(command);
	if (!match) return null;
	const args = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
	const positional = args.filter((arg) => !arg.startsWith("-"));
	// The first positional is the remote; everything after it is a refspec.
	const refspecs = positional.slice(1);
	if (refspecs.length === 0) return null;
	const targets: string[] = [];
	for (const spec of refspecs) {
		const bare = spec.replace(/^\+/, "");
		const destination = bare.includes(":") ? bare.slice(bare.lastIndexOf(":") + 1) : bare;
		const name = destination.replace(/^refs\/heads\//, "").trim();
		if (!name) return null;
		targets.push(name);
	}
	return targets;
}

export function laneSummary(campaign: Campaign): string {
	const open = campaign.lanes.filter((lane) => lane.state !== "integrated");
	if (open.length === 0) return "none";
	return open.map((lane) => `${lane.key} (${lane.kind}, ${lane.model}, ${lane.state})`).join("; ");
}

export function openReview(campaign: Campaign): { ok: true } | { ok: false; error: string } {
	if (campaign.slicesDone < campaign.slicesTotal) {
		return {
			ok: false,
			error: `review opens after every slice is done: ${campaign.slicesDone} of ${campaign.slicesTotal}. Record finished slices with set-slices first.`,
		};
	}
	const open = campaign.lanes.filter((lane) => lane.kind === "implement" && lane.state !== "integrated");
	if (open.length > 0) {
		return { ok: false, error: `integrate these lanes before review: ${open.map((lane) => lane.key).join(", ")}` };
	}
	return { ok: true };
}

export function contractPrompt(
	liveOrClosed: Campaign | null,
	armed: boolean,
	now: number,
	config: GuardConfig = DEFAULT_CONFIG,
	tiers: TierLists = DEFAULT_TIERS,
): string {
	const campaign = liveOrClosed && liveOrClosed.status !== "closed" ? liveOrClosed : null;
	if (!campaign) {
		if (!armed) return "";
		return `Coordinator guard: armed, no campaign registered.

The coordinator skill is loaded, so dispatches are blocked until you call coordinator_campaign with action "start" (slug, worktree, plan_path, slices_total, authorized). Registering the campaign is what makes routing, lane, and status enforcement possible.

These are the tiers that will be enforced. Position one is what to reach for; the rest are accepted fallbacks:
${renderTiers(tiers)}`;
	}

	const staleMinutes = campaign.lastStatusAt === null ? null : Math.floor((now - campaign.lastStatusAt) / 60_000);
	const openLanes = campaign.lanes.filter((lane) => lane.state !== "integrated");

	return `Coordinator guard: campaign ${campaign.slug} is ${campaign.status}.

Worktree: ${campaign.worktree}
Plan: ${campaign.planPath ?? "unrecorded"}
Slices: ${campaign.slicesDone} done of ${campaign.slicesTotal}
Open lanes: ${laneSummary(campaign)}
Last status block: ${staleMinutes === null ? "never" : `${staleMinutes} minutes ago`}

This campaign is the goal. It continues across turns and survives a provider error, so a
failed turn is retried rather than treated as an ending. Do not park it: marking a goal
blocked or complete while slices remain or lanes are open is refused, and the way to stop
deliberately is /campaign close.

AUTHORIZED      ${campaign.authorized}
NOT AUTHORIZED  merge; close or reopen PRs; publish releases; touch production; force-push over shared history; delete outside the named scope

These are enforced at the tool boundary, not by your memory of them. A dispatch that breaks one fails:

- Reaching past the first model in a class is allowed only when the routing reason says why
  the preferred one was not usable, for example "claude-bridge rate-limited at 14:02".
- Every launch pins provider/model:effort, and only these route. Position one is what to reach
  for; the rest are accepted fallbacks. Anything else is refused:
${tierTable(tiers)}
- Every launch opens with a routing header, and its model must match what the call carries:
  ROUTE: <key> | class <1|2|3> | <provider/model:effort> | <why this class>
  Class 3 implementation needs a real justification, not the word "complex", and a reason
  describing broader work than its class allows is refused too: class 1 is a complete,
  mechanical slice, class 2 is integration work, class 3 is cross-layer or long-horizon.
- Review is a separate table with its own two classes, declared as "review 1" or "review 2",
  never an implementation class:
${reviewTable(tiers)}
  Review runs once at the end, so the class is the risk of the whole branch. The same model
  at a different effort is a different class.
- Every dispatched prompt names the worktree, the exact HEAD it must be at, that the agent stops if HEAD differs, and that it commits locally and never pushes, never runs gh, never touches a PR.
- Every dispatch is a workflowScript with literal children, and top-level async stated. A writer or a reviewer is the only child of its own script: return runs.run('<key>', { agent: 'campaign-worker', model: '<provider/model:effort>', task: \`ROUTE: ...\` }). Only independent read-only investigations share a script.
- Every dispatch uses a campaign role, and the role must match the work: campaign-worker implements, campaign-reviewer reviews, campaign-scout investigates. Builtin roles (worker, reviewer, delegate, oracle) are refused: their prompts are not the campaign's.
- No turnBudget, toolBudget, or maxTurns, ever. Bound liveness with elapsed time and serial milestones.
- Committing, staging, rebasing, pushing, and PR state are yours alone and are never dispatched.
- Reviewers only after every slice is done and you call coordinator_campaign action "open-review". One at a time.
- At most ${config.laneCap} open writer lanes; a returned lane counts until you record it integrated with coordinator_lane.
- A launch while the status block is older than ${config.statusMaxAgeMs / 60_000} minutes fails. Print the block, then launch in the same turn.
- The same run can be steered ${config.steerCap} times; past that, stop it, split into serial milestones, and re-dispatch.
${openLanes.length > 0 ? "\nAgents are in flight. Ending your turn without reporting on them is not an option: report, then keep working." : ""}`;
}

export function continuationPrompt(campaign: Campaign): string {
	const running = campaign.lanes.filter((lane) => lane.state === "running");
	const returned = campaign.lanes.filter((lane) => lane.state === "returned");
	return `Continue the campaign. This is an automatic continuation because work is in flight and the turn ended.

Running lanes: ${running.map((lane) => lane.key).join(", ") || "none"}
Returned, not yet integrated: ${returned.map((lane) => lane.key).join(", ") || "none"}
Slices: ${campaign.slicesDone} done of ${campaign.slicesTotal}

Do these in order:

1. Check each running lane is actually alive with subagent action "status". A quiet agent is not a working agent, and a dispatch that returns nothing inside its liveness bound is a failed dispatch, not a slow one. Mark dead lanes with coordinator_lane action "dead", and close a read-only lane that has reported with action "done".
2. Integrate any returned writer lane into the campaign branch yourself, run the gates yourself, and record it with coordinator_lane action "integrated".
3. Print the status block.
4. Start the next unblocked slice, or if every slice is done, call coordinator_campaign action "open-review" and dispatch the single final reviewer.

If you are waiting, you are wrong: either work is running and you report on it, or work is not running and you start some. A missing external dependency parks that one gate, never the campaign.`;
}

export function parseModelPin(model: unknown): { id: string; effort: ThinkingLevel } | null {
	if (typeof model !== "string" || !model.includes("/")) return null;
	const colon = model.lastIndexOf(":");
	if (colon <= 0) return null;
	const effort = model.slice(colon + 1);
	if (!THINKING_LEVELS.some((level) => level === effort)) return null;
	return { id: model.slice(0, colon), effort: effort as ThinkingLevel };
}

export type ReviewClass = 1 | 2;

/**
 * The tiers, as ordered lists of pins. Ordered because position one is what the contract
 * tells the coordinator to reach for and the rest are accepted fallbacks: restricting a
 * class to a single provider means one outage stalls the campaign on refusals, while an
 * unordered set gives the coordinator no default at all. A class is a model AT an effort,
 * so every entry carries both.
 */
export interface TierLists {
	class: Record<ImplementationClass, string[]>;
	review: Record<ReviewClass, string[]>;
}

export const DEFAULT_TIERS: TierLists = {
	class: {
		1: ["claude-bridge/claude-sonnet-5:medium", "openai-codex/gpt-5.6-luna:high"],
		2: ["claude-bridge/claude-opus-5:low", "openai-codex/gpt-5.6-terra:medium"],
		3: ["claude-bridge/claude-opus-5:medium", "openai-codex/gpt-5.6-sol:medium"],
	},
	review: {
		1: ["claude-bridge/claude-opus-5:high", "openai-codex/gpt-5.6-terra:xhigh"],
		2: ["claude-bridge/claude-opus-5:xhigh", "openai-codex/gpt-5.6-sol:xhigh"],
	},
};

/**
 * OpenAI's calibrated one-entry defaults. `/campaign models gpt` selects these all at
 * once, including review tiers, instead of making the coordinator repeat five changes
 * and accidentally leave an old Claude fallback behind.
 */
export const GPT_DEFAULT_TIERS: TierLists = {
	class: {
		1: ["openai-codex/gpt-5.6-luna:high"],
		2: ["openai-codex/gpt-5.6-terra:medium"],
		3: ["openai-codex/gpt-5.6-sol:medium"],
	},
	review: {
		1: ["openai-codex/gpt-5.6-terra:xhigh"],
		2: ["openai-codex/gpt-5.6-sol:xhigh"],
	},
};

/** Claude's calibrated one-entry defaults, including its separate review axis. */
export const CLAUDE_DEFAULT_TIERS: TierLists = {
	class: {
		1: ["claude-bridge/claude-sonnet-5:medium"],
		2: ["claude-bridge/claude-opus-5:low"],
		3: ["claude-bridge/claude-opus-5:medium"],
	},
	review: {
		1: ["claude-bridge/claude-opus-5:high"],
		2: ["claude-bridge/claude-opus-5:xhigh"],
	},
};

/** A pin's bare model name, so a list entry matches whichever provider spells it locally. */
function bareModel(id: string): string {
	const slash = id.lastIndexOf("/");
	return (slash === -1 ? id : id.slice(slash + 1)).toLowerCase();
}

function entryMatches(entry: string, pin: { id: string; effort: ThinkingLevel }): boolean {
	const parsed = parseModelPin(entry);
	if (!parsed) return false;
	if (parsed.effort !== pin.effort) return false;
	const listed = bareModel(parsed.id);
	const dispatched = bareModel(pin.id);
	return listed === dispatched || dispatched.includes(listed) || listed.includes(dispatched);
}

function classFrom(lists: Record<number, string[]>, pin: { id: string; effort: ThinkingLevel }): number | null {
	for (const [cls, entries] of Object.entries(lists)) {
		if (entries.some((entry) => entryMatches(entry, pin))) return Number(cls);
	}
	return null;
}

export function modelClass(modelId: string, effort: ThinkingLevel, tiers: TierLists = DEFAULT_TIERS): ImplementationClass | null {
	return classFrom(tiers.class, { id: modelId, effort }) as ImplementationClass | null;
}

export function reviewClass(modelId: string, effort: ThinkingLevel, tiers: TierLists = DEFAULT_TIERS): ReviewClass | null {
	return classFrom(tiers.review, { id: modelId, effort }) as ReviewClass | null;
}

/** The efforts a table lists for a model, for a refusal to quote back. */
function effortsFor(lists: Record<number, string[]>, modelId: string): ThinkingLevel[] {
	const dispatched = bareModel(modelId);
	const found: ThinkingLevel[] = [];
	for (const entries of Object.values(lists)) {
		for (const entry of entries) {
			const parsed = parseModelPin(entry);
			if (!parsed) continue;
			const listed = bareModel(parsed.id);
			if ((listed === dispatched || dispatched.includes(listed) || listed.includes(dispatched)) && !found.includes(parsed.effort)) {
				found.push(parsed.effort);
			}
		}
	}
	return found;
}

export function listedEfforts(modelId: string, tiers: TierLists = DEFAULT_TIERS): ThinkingLevel[] {
	return effortsFor(tiers.class, modelId);
}

export function listedReviewEfforts(modelId: string, tiers: TierLists = DEFAULT_TIERS): ThinkingLevel[] {
	return effortsFor(tiers.review, modelId);
}

/**
 * A user-supplied tier list. Validated rather than trusted: an entry without an effort is
 * the exact mistake the whole pin rule exists to prevent, and a silently dropped entry
 * would make the printed table lie about what is enforced.
 */
export function parseTierEntries(raw: string): { ok: true; entries: string[] } | { ok: false; error: string } {
	const entries = raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (entries.length === 0) return { ok: false, error: "name at least one model as provider/model:effort." };
	for (const entry of entries) {
		const pin = parseModelPin(entry);
		if (!pin) {
			return { ok: false, error: `"${entry}" is not provider/model:effort. A class is a model at an effort, so both are required.` };
		}
		if (!entry.includes("/")) {
			return { ok: false, error: `"${entry}" has no provider prefix. Write it the way the local harness spells it, for example openai-codex/gpt-5.6-terra:xhigh.` };
		}
	}
	return { ok: true, entries };
}

/**
 * Whether these entries already belong to another class on the same axis. classFrom returns
 * the first match, so a duplicate would make the command report one class while dispatches
 * are graded as another.
 */
export function findTierClash(tiers: TierLists, axis: "class" | "review", cls: number, entries: string[]): string | null {
	const lists: Record<number, string[]> = axis === "review" ? tiers.review : tiers.class;
	for (const entry of entries) {
		const pin = parseModelPin(entry);
		if (!pin) continue;
		for (const [other, existing] of Object.entries(lists)) {
			if (Number(other) === cls) continue;
			if (existing.some((candidate) => entryMatches(candidate, pin))) {
				return `${entry} is already in ${axis} ${other}.`;
			}
		}
	}
	return null;
}

/** The tiers with one class replaced, leaving the rest as they were. */
export function withTierList(tiers: TierLists, axis: "class" | "review", cls: number, entries: string[]): TierLists {
	const next: TierLists = { class: { ...tiers.class }, review: { ...tiers.review } };
	if (axis === "review") next.review[cls as ReviewClass] = entries;
	else next.class[cls as ImplementationClass] = entries;
	return next;
}

/** The table as the contract and refusals print it: position one first, marked as preferred. */
export function renderTiers(tiers: TierLists = DEFAULT_TIERS): string {
	const rows: string[] = [];
	for (const [axis, lists] of [
		["class", tiers.class],
		["review", tiers.review],
	] as const) {
		for (const [cls, entries] of Object.entries(lists)) {
			const shown = entries.map((entry, index) => (index === 0 ? `${entry} (preferred)` : entry));
			rows.push(`  ${axis} ${cls}  ${shown.join("  |  ")}`);
		}
	}
	return rows.join("\n");
}

function tierTable(tiers: TierLists = DEFAULT_TIERS): string {
	return Object.entries(tiers.class)
		.map(([cls, entries]) => `  class ${cls}  ${entries.join("  |  ")}`)
		.join("\n");
}

function reviewTable(tiers: TierLists = DEFAULT_TIERS): string {
	return Object.entries(tiers.review)
		.map(([cls, entries]) => `  review ${cls}  ${entries.join("  |  ")}`)
		.join("\n");
}

export function parseRouteHeader(text: string): RouteHeader | null {
	// Line-anchored for a plain prompt, and after a quote or backtick for a child inside a script.
	const match = /(?:^|[`'"])[ \t>*-]*ROUTE:\s*(.+)$/im.exec(text);
	if (!match) return null;
	const parts = match[1].split("|").map((part) => part.trim());
	if (parts.length < 4) return null;
	const tier = /^(class|review)\s*([123])$/i.exec(parts[1]);
	if (!tier) return null;
	const axis = tier[1].toLowerCase() as "class" | "review";
	const cls = Number(tier[2]) as ImplementationClass;
	if (axis === "review" && cls > 2) return null;
	return {
		key: parts[0],
		axis,
		cls,
		model: parts[2],
		reason: parts.slice(3).join(" | ").trim(),
	};
}

export interface StatusBlock {
	ok: boolean;
	missing: string[];
	/** What the block claims, when it states it in the documented shape. */
	claimedSlicesDone: number | null;
	claimedSlicesTotal: number | null;
}

export function readStatusBlock(text: string): StatusBlock {
	// Validate the block itself, not the prose around it: a message that happens to mention a
	// PR elsewhere must not make an incomplete block look fresh. Fields share lines in the real
	// layout (CAMPAIGN sits beside WORKTREE), so labels are matched within the block region.
	const lines = text.split("\n");
	const start = lines.findIndex((line) => /^[ \t>*-]*CAMPAIGN\b/i.test(line));
	if (start === -1) return { ok: false, missing: [...STATUS_FIELDS], claimedSlicesDone: null, claimedSlicesTotal: null };
	let end = lines.findIndex((line, index) => index >= start && /^[ \t>*-]*NEXT\b/i.test(line));
	if (end === -1) end = Math.min(lines.length - 1, start + STATUS_FIELDS.length + 4);
	const block = lines.slice(start, end + 1).join("\n");
	const missing = STATUS_FIELDS.filter((field) => !new RegExp(`\\b${field}\\b`, "i").test(block));
	const claimed = /^[ \t>*-]*SLICES\D*(\d+)\s*done\s*\/\s*(\d+)\s*total/im.exec(block);
	return {
		ok: missing.length === 0,
		missing,
		claimedSlicesDone: claimed ? Number(claimed[1]) : null,
		claimedSlicesTotal: claimed ? Number(claimed[2]) : null,
	};
}

/**
 * Whether a printed block's slice count matches the ledger that actually gates review.
 *
 * The block was validated for freshness and its numbers ignored, so a campaign could print
 * "6 done / 31 total" every turn while the recorded count stayed at zero, and did. That
 * number is not decoration: open-review refuses until done equals total, so an unrecorded
 * count opens review at the wrong time or never.
 */
export function statusBlockDisagreement(block: StatusBlock, campaign: Campaign): string | null {
	// A SLICES line the guard cannot read is not agreement. Returning null here let
	// "SLICES in progress" refresh the ledger and skip the comparison entirely.
	if (block.claimedSlicesDone === null || block.claimedSlicesTotal === null) {
		return `its SLICES line does not state a count the guard can read. Write it as "SLICES <n> done / <n> total", so the printed number can be checked against the recorded one.`;
	}
	if (block.claimedSlicesDone === campaign.slicesDone && block.claimedSlicesTotal === campaign.slicesTotal) return null;
	return `the block says ${block.claimedSlicesDone} done of ${block.claimedSlicesTotal}, the campaign records ${campaign.slicesDone} of ${campaign.slicesTotal}. Record the real count with coordinator_campaign action "set-slices", or correct the block. Review opens on the recorded number, not the printed one.`;
}


function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}


export function isManagementAction(input: Record<string, unknown>): boolean {
	const action = text(input.action);
	if (!action) return false;
	return MANAGEMENT_ACTIONS.has(action);
}

function isLaunch(input: Record<string, unknown>): boolean {
	if (isManagementAction(input)) return false;
	// tasks and chain are the removed batch forms. The installed subagent rejects them itself,
	// but a guard that depends on another package's version check is not a guard.
	return (
		typeof input.agent === "string" ||
		text(input.workflowScript).length > 0 ||
		input.tasks !== undefined ||
		input.chain !== undefined
	);
}

function runIdOf(input: Record<string, unknown>): string {
	// A steer can address its run by id or by directory; both have to count against the cap.
	return text(input.id) || text(input.runId) || text(input.dir);
}

function deny(code: string, reason: string, teach = false): GuardDenial {
	return { allow: false, code, reason, ...(teach ? { teach: true } : {}) };
}

/**
 * One refusal listing every problem found, because revealing them one at a time costs a
 * round trip each. A real campaign spent five attempts and two minutes on its first
 * dispatch, learning one rule per refusal.
 */
function denyAll(problems: Array<{ code: string; reason: string }>): GuardDenial {
	if (problems.length === 1) return deny(problems[0].code, problems[0].reason);
	const list = problems.map((problem, index) => `${index + 1}. [${problem.code}] ${problem.reason}`).join("\n\n");
	return deny(problems[0].code, `This launch has ${problems.length} problems. Fix them together and retry once:\n\n${list}`);
}

function checkBash(command: string, campaign: Campaign | null): GuardDecision {
	// Checks are a release-time fact, read once when the PR is made ready. A campaign spent
	// hours reporting "checks 0/14 (billing-blocked)" on a PR whose checks could not pass,
	// which is loop time spent on something no slice depends on.
	if (campaign && campaign.slicesDone < campaign.slicesTotal) {
		const watching = /(^|[\s;&|(])gh\s+(run\s+(watch|list|view)|pr\s+checks)\b/i.test(command)
			|| /(^|[\s;&|(])gh\s+pr\s+view\b[^;&|]*statusCheckRollup/i.test(command);
		if (watching) {
			return deny(
				"CG024",
				`Read CI once, when you make the PR ready at the end. This campaign is at ${campaign.slicesDone} of ${campaign.slicesTotal} slices, and no slice depends on a check result: a red or missing check now is the same work either way, and a check that cannot pass will not start passing because it was watched. Update the PR body and keep going.`,
			);
		}
	}
	const spawn = /(^|[\s;&|(])((codex\s+(exec|resume))|(claude\s+(-p|--print))|(pi\s+(-p|--prompt|exec))|(npx\s+(-y\s+)?pi\b))/i;
	if (spawn.test(command)) {
		return deny(
			"CG014",
			"Spawning an agent through bash bypasses every dispatch rule. Use the subagent tool so the routing table, model pin, and lane accounting apply. If this genuinely is not a dispatch, rename the command.",
		);
	}
	// Global options sit between git and its subcommand, so `git -C <path> reset --hard` is the
	// same command as `git reset --hard` and has to be matched the same way.
	const git = String.raw`git(?:\s+(?:-[cC]\s+\S+|--\S+|-[^-\s]\S*))*\s+`;
	const discardsTree =
		"discards uncommitted work with no prompt, and a backup branch does not save it because a branch only captures commits. To move a branch pointer use git switch -C <branch> <sha> or git update-ref, which refuse rather than discard. If you truly need a clean tree, commit or export first and say so in the status block.";
	const rewritesHistory =
		'rewrites published history, which is outside the recorded authorization and can destroy work that is not yours. Ask the user before any force push, naming the exact branch. Once they approve it, they record it with "/campaign authorize force-push <branch>"; do not close and restart the campaign to widen your own scope, which throws away the ledger review opens on.';
	const destructive: Array<[RegExp, string, string]> = [
		[new RegExp(`${git}reset\\s+--hard`, "i"), "git reset --hard", discardsTree],
		[new RegExp(`${git}stash(\\s|$)`, "i"), "git stash", discardsTree],
		[new RegExp(`${git}restore(\\s|$)`, "i"), "git restore", discardsTree],
		[new RegExp(`${git}checkout\\s+--\\s`, "i"), "git checkout -- <path>", discardsTree],
		[new RegExp(`${git}push\\s+(.*\\s)?(--force(-with-lease)?(=\\S*)?|-f)(\\s|$)`, "i"), "This force push", rewritesHistory],
		// git's own force syntax: a refspec whose source is prefixed with +, destination optional.
		[new RegExp(`${git}push\\s+(\\S+\\s+)*\\+\\S+`, "i"), "A refspec beginning with + is a force push, and this one", rewritesHistory],
		[
			new RegExp(`${git}worktree\\s+remove\\s+(.*\\s)?(--force|-f)(\\s|$)`, "i"),
			"git worktree remove --force",
			"deletes a worktree and any uncommitted work inside it. Ask the user first, naming the exact worktree.",
		],
	];
	for (const [pattern, label, reason] of destructive) {
		if (!pattern.test(command)) continue;
		// A force push the user granted by branch name is the one case that passes, and only
		// when every ref this command writes is on that list: a second refspec alongside the
		// granted one is a different push.
		if (reason === rewritesHistory && campaign?.grants?.forcePush?.length) {
			const targets = forcePushTargets(command);
			const allowed = campaign.grants.forcePush;
			if (targets && targets.length > 0 && targets.every((target) => allowed.includes(target))) continue;
			return deny(
				"CG015",
				`${label} ${reason} Force push is granted here for ${allowed.join(", ")}, and this command writes ${targets?.join(", ") ?? "refs that cannot be read from the command line"}.`,
			);
		}
		return deny("CG015", `${label} ${reason}`);
	}
	return { allow: true };
}

// Property keys appear bare or quoted depending on how the script was written, and a script
// built with JSON.stringify quotes every one of them.
const AGENT_KEY = /(?:\b|["'])agent["']?\s*:/g;

export interface ScriptChild {
	agent: string;
	model: string;
	task: string;
	context?: string;
	worktree?: boolean | "unreadable";
}

/**
 * Child specifications, kept associated rather than counted. Comparing bags of models across
 * a whole script cannot tell that child A declared what child B launched, so each child's
 * own object is read: its agent, its model, and its task with its routing header.
 */
export function parseScriptChildren(script: string): { children: ScriptChild[]; agentKeys: number; defect?: string } {
	const agentKeys = countAgentKeys(script);
	const children: ScriptChild[] = [];

	// Children are read from the runs.run and runs.all call sites, not from any object that
	// happens to sit in the script: a compliant literal defined once and fanned out through
	// spreads or variables would otherwise be judged once and executed many times. Every
	// spec argument must be a literal object, or the script cannot be verified at all.
	for (const site of findCallSites(script)) {
		const args = site.args.trimStart();
		if (site.callee === "runs.run") {
			const spec = skipFirstArgument(args);
			if (spec === null || spec[0] !== "{") {
				return { children, agentKeys, defect: `runs.run's spec argument must be a literal object; "${truncate(args)}" cannot be verified.` };
			}
			const child = readChild(spec, children);
			if (typeof child === "string") return { children, agentKeys, defect: child };
		} else {
			if (args[0] !== "[") {
				return { children, agentKeys, defect: `runs.all takes a literal array of literal child objects; "${truncate(args)}" cannot be verified.` };
			}
			let index = 1;
			while (index < args.length) {
				while (index < args.length && /[\s,]/.test(args[index])) index++;
				if (args[index] === "]" || index >= args.length) break;
				if (args[index] !== "{") {
					return { children, agentKeys, defect: `every runs.all element must be a literal object; "${truncate(args.slice(index))}" cannot be verified.` };
				}
				const body = readObjectLiteral(args, index);
				if (!body) return { children, agentKeys, defect: "unterminated object literal in runs.all." };
				const child = readChild(body, children);
				if (typeof child === "string") return { children, agentKeys, defect: child };
				index += body.length;
			}
		}
	}
	return { children, agentKeys };
}

/** Reads one child spec, or returns why it cannot be trusted. */
function readChild(body: string, children: ScriptChild[]): ScriptChild | string {
	if (hasTopLevelSpread(body)) {
		return `a child spec uses spread syntax (${truncate(body)}), so what it launches cannot be read. Write every field literally.`;
	}
	const agent = readField(body, "agent");
	if (agent === undefined) {
		return `a child spec has no literal agent field (${truncate(body)}). Shorthand and computed fields cannot be verified; write agent, model, and task literally.`;
	}
	const child = {
		agent,
		model: readField(body, "model") ?? "",
		task: readField(body, "task") ?? "",
		context: readField(body, "context"),
		worktree: readFlag(body, "worktree"),
	};
	children.push(child);
	return child;
}

/** The routing row the guard will accept for this role, so a correction cannot be refused. */
export function routeShapeFor(agent: string | undefined): string {
	return agent === "campaign-reviewer"
		? "ROUTE: <key> | review <1|2> | <provider/model:effort> | <why this class>"
		: "ROUTE: <key> | class <1|2|3> | <provider/model:effort> | <why this class>";
}

function truncate(value: string): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

/** Spread tokens at the top level of an object literal, ignoring nested strings and objects. */
function hasTopLevelSpread(body: string): boolean {
	let depth = 0;
	let quote: string | null = null;
	for (let index = 0; index < body.length; index++) {
		const char = body[index];
		if (quote) {
			if (char === "\\") index++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") quote = char;
		else if (char === "{" || char === "[" || char === "(") depth++;
		else if (char === "}" || char === "]" || char === ")") depth--;
		else if (char === "." && depth === 1 && body.startsWith("...", index)) return true;
	}
	return false;
}

/** Every runs.run( and runs.all( call outside string literals, with its argument text. */
function findCallSites(script: string): Array<{ callee: "runs.run" | "runs.all"; args: string }> {
	const sites: Array<{ callee: "runs.run" | "runs.all"; args: string }> = [];
	let quote: string | null = null;
	for (let index = 0; index < script.length; index++) {
		const char = script[index];
		if (quote) {
			if (char === "\\") index++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			continue;
		}
		for (const callee of ["runs.run", "runs.all"] as const) {
			if (!script.startsWith(callee, index)) continue;
			if (index > 0 && /[\w$.]/.test(script[index - 1])) continue;
			let cursor = index + callee.length;
			while (cursor < script.length && /\s/.test(script[cursor])) cursor++;
			if (script[cursor] !== "(") continue;
			const args = readParenthesized(script, cursor);
			if (args !== null) {
				sites.push({ callee, args });
				index = cursor;
			}
			break;
		}
	}
	return sites;
}

/** The text between a paren and its match, string-aware. */
function readParenthesized(source: string, start: number): string | null {
	let depth = 0;
	let quote: string | null = null;
	for (let index = start; index < source.length; index++) {
		const char = source[index];
		if (quote) {
			if (char === "\\") index++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") quote = char;
		else if (char === "(") depth++;
		else if (char === ")") {
			depth--;
			if (depth === 0) return source.slice(start + 1, index);
		}
	}
	return null;
}

/** Skips runs.run's key argument, returning the rest, or null when the key is not a literal. */
function skipFirstArgument(args: string): string | null {
	const quote = args[0];
	if (quote !== "'" && quote !== '"' && quote !== "`") return null;
	for (let index = 1; index < args.length; index++) {
		if (args[index] === "\\") {
			index++;
			continue;
		}
		if (args[index] === quote) {
			let cursor = index + 1;
			while (cursor < args.length && /\s/.test(args[cursor])) cursor++;
			if (args[cursor] !== ",") return null;
			cursor++;
			while (cursor < args.length && /\s/.test(args[cursor])) cursor++;
			return args.slice(cursor);
		}
	}
	return null;
}

/**
 * Agent keys that are actually properties, bare or quoted. A prompt is free to contain the
 * words "assigned agent: scout", and counting those would refuse a valid script.
 */
function countAgentKeys(script: string): number {
	let count = 0;
	for (let index = 0; index < script.length; index++) {
		const char = script[index];
		if (char === "'" || char === '"' || char === "`") {
			// A quoted token is a key only when a colon follows its closing quote.
			let content = "";
			let cursor = index + 1;
			for (; cursor < script.length; cursor++) {
				if (script[cursor] === "\\") {
					cursor++;
					continue;
				}
				if (script[cursor] === char) break;
				content += script[cursor];
			}
			let after = cursor + 1;
			while (after < script.length && /\s/.test(script[after])) after++;
			if (script[after] === ":" && content.trim().toLowerCase() === "agent") count++;
			index = cursor;
			continue;
		}
		if (/[A-Za-z_$]/.test(char)) {
			const word = /^[A-Za-z_$][\w$]*/.exec(script.slice(index))?.[0] ?? "";
			let after = index + word.length;
			while (after < script.length && /\s/.test(script[after])) after++;
			if (word.toLowerCase() === "agent" && script[after] === ":") count++;
			index += word.length - 1;
		}
	}
	return count;
}

/** The text of the object literal starting at `start`, quote and nesting aware. */
function readObjectLiteral(source: string, start: number): string | null {
	let depth = 0;
	let quote: string | null = null;
	for (let index = start; index < source.length; index++) {
		const char = source[index];
		if (quote) {
			if (char === "\\") index++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") quote = char;
		else if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return source.slice(start, index + 1);
		}
	}
	return null;
}

/** A field's literal string value, or undefined when it is absent or not a literal. */
/**
 * Top-level properties of an object literal, as raw source slices, or null when the whole
 * body could not be consumed as written-out properties.
 *
 * The task is free-form text that routinely discusses this guard's own vocabulary, so a
 * field cannot be located by searching the body: a prompt saying "do not ask for
 * worktree: true" is not a request for a worktree. This walks the literal instead,
 * skipping strings, template substitutions and nested structures, so only properties of
 * the child object itself are returned.
 *
 * Anything it cannot read as a literal property, a shorthand, a spread, a computed key,
 * makes the whole object unverifiable rather than partially clean: the runtime still acts
 * on those properties, so stopping early and reporting the rest as absent is a bypass.
 * Keys keep their exact case, because JavaScript property names are case-sensitive and a
 * differently cased twin is a different property, not the same one.
 */
function topLevelFields(rawBody: string): Map<string, string> | null {
	const trimmed = rawBody.trim();
	const objectBody = trimmed.startsWith("{")
		? trimmed.slice(1, trimmed.endsWith("}") ? -1 : undefined)
		: trimmed;
	const fields = new Map<string, string>();
	let index = 0;
	const skipValue = (from: number): number => {
		let depth = 0;
		const templates: number[] = [];
		for (let at = from; at < objectBody.length; at++) {
			const char = objectBody[at];
			if (char === "'" || char === '"' || char === "`") {
				for (let scan = at + 1; scan < objectBody.length; scan++) {
					if (objectBody[scan] === "\\") { scan++; continue; }
					if (char === "`" && objectBody[scan] === "$" && objectBody[scan + 1] === "{") {
						templates.push(depth);
						depth++;
						scan++;
						continue;
					}
					if (char === "`" && objectBody[scan] === "}" && templates.length > 0) {
						depth = templates.pop() as number;
						continue;
					}
					if (objectBody[scan] === char && templates.length === 0) { at = scan; break; }
					if (scan === objectBody.length - 1) at = scan;
				}
				continue;
			}
			if (char === "{" || char === "[" || char === "(") depth++;
			else if (char === "}" || char === "]" || char === ")") {
				if (depth === 0) return at;
				depth--;
			} else if (char === "," && depth === 0) return at;
		}
		return objectBody.length;
	};
	while (index < objectBody.length) {
		while (index < objectBody.length && /[\s,]/.test(objectBody[index] as string)) index++;
		if (index >= objectBody.length) break;
		const key = /^["']?([A-Za-z_$][\w$]*)["']?\s*:/.exec(objectBody.slice(index));
		if (!key) return null;
		const valueStart = index + key[0].length;
		const valueEnd = skipValue(valueStart);
		fields.set(key[1] as string, objectBody.slice(valueStart, valueEnd).trim());
		index = valueEnd + 1;
	}
	return fields;
}

function readField(objectBody: string, field: string): string | undefined {
	const raw = topLevelFields(objectBody)?.get(field);
	if (raw === undefined) return undefined;
	const quote = raw[0];
	if (quote !== "'" && quote !== '"' && quote !== "`") return "";
	let value = "";
	for (let index = 1; index < raw.length; index++) {
		const char = raw[index];
		if (char === "\\") {
			value += raw[index + 1] === "n" ? "\n" : raw[index + 1];
			index++;
			continue;
		}
		if (char === quote) return value;
		value += char;
	}
	return undefined;
}

/** A boolean the guard must act on: anything not written as a literal cannot be read as absent. */
function readFlag(objectBody: string, field: string): boolean | "unreadable" | undefined {
	const fields = topLevelFields(objectBody);
	if (!fields) return "unreadable";
	const raw = fields.get(field);
	if (raw === undefined) return undefined;
	if (raw === "true") return true;
	if (raw === "false") return false;
	return "unreadable";
}

/** Model pin and declared class, checked the same way for a lone dispatch and for a child. */
function checkRoute(route: RouteHeader, agent: string | undefined, tiers: TierLists): GuardDecision {
	const pin = parseModelPin(route.model);
	if (!pin) return deny("CG004", `The routing header model ${route.model} is not pinned as provider/model:effort.`);

	// The role decides which table applies, so a reviewer can never be graded against the
	// implementation tiers and a writer can never claim a review class.
	const wantsReview = agent === "campaign-reviewer";
	if (wantsReview && route.axis !== "review") {
		return deny(
			"CG004",
			`Route ${route.key} is dispatched as campaign-reviewer, so its header declares a review class, not an implementation class:\nROUTE: ${route.key} | review <1|2> | <provider/model:effort> | <why this class>\n${reviewTable(tiers)}`,
			true,
		);
	}
	if (!wantsReview && route.axis === "review") {
		return deny(
			"CG004",
			`Route ${route.key} declares a review class but is dispatched as ${agent ?? "a non-reviewer"}. Review classes belong to campaign-reviewer dispatches; implementation and investigation use class 1, 2, or 3.`,
			true,
		);
	}

	const actualClass = wantsReview ? reviewClass(pin.id, pin.effort, tiers) : modelClass(pin.id, pin.effort, tiers);
	const table = wantsReview ? reviewTable(tiers) : tierTable(tiers);
	const axis = wantsReview ? "review" : "class";

	if (actualClass === null) {
		const listed = wantsReview ? listedReviewEfforts(pin.id, tiers) : listedEfforts(pin.id, tiers);
		if (listed.length > 0) {
			return deny(
				"CG004",
				`The ${axis} table lists ${pin.id} at ${listed.join(" or ")} effort, not ${pin.effort}. A ${axis} is a model at an effort, so running a listed model at an unlisted effort is not the tier you declared.`,
			);
		}
		return deny(
			"CG004",
			`${pin.id} is not in the ${axis} table, so its ${axis} cannot be checked. Route to one of these exactly, model and effort together:\n${table}\nThe provider prefix stays as your harness spells it, for example openai-codex/gpt-5.6-terra:xhigh.`,
		);
	}
	if (actualClass !== route.cls) {
		return deny(
			"CG004",
			`Route ${route.key} declares ${axis} ${route.cls} but ${pin.id} at ${pin.effort} is ${axis} ${actualClass} in the ${axis} table. Fix whichever is wrong: choosing a ${axis} is choosing a model, not a label.`,
		);
	}
	return { allow: true };
}

function checkBudgets(input: Record<string, unknown>, script: string): GuardDecision {
	const forbidden = ["turnBudget", "toolBudget"] as const;
	for (const key of forbidden) {
		if (input[key] !== undefined) {
			return deny(
				"CG005",
				`${key} is a hard leash on a dispatched agent and the skill forbids it: turn count does not measure progress, and a killed agent loses finished work. Remove ${key}. Bound liveness with elapsed time, and split work that will not fit into serial milestones.`,
			);
		}
	}
	if (/\b(turnBudget|toolBudget|maxTurns|graceTurns)\b/.test(script)) {
		return deny(
			"CG005",
			"The workflow script carries a hard turn or tool budget. Remove it: bound liveness with elapsed time and serial milestones instead.",
		);
	}
	return { allow: true };
}

/** One prompt the judge must read before this launch can be decided. */
export interface JudgeTarget {
	routeKey: string;
	prompt: string;
	agent?: string;
	declaredClass: ImplementationClass;
	model: string;
}

export type StructureDecision =
	| { allow: false; code: string; reason: string; teach?: boolean }
	| { allow: true; judge: JudgeTarget[] };

/**
 * Phase one: everything decidable from the call itself. Runs before any model call, so a
 * malformed dispatch is refused without spending one.
 */
/**
 * The only roles a campaign may dispatch. Their prompts live beside the guard in agents/
 * and are registered with pi-subagents at load. The builtin roles are not usable here:
 * the builtin reviewer carries edit and write tools and is told to apply fixes, the
 * builtin worker forks the coordinator's whole conversation into the child, and the
 * builtin delegate appends the parent system prompt, campaign contract included. What a
 * dispatched agent is told is part of what the guard guarantees, so the guard owns it.
 */
export const CAMPAIGN_AGENTS: Record<string, JudgedKind> = {
	"campaign-worker": "implement",
	"campaign-reviewer": "review",
	"campaign-scout": "investigate",
};

function checkCampaignAgent(agent: string | undefined): GuardDecision {
	if (agent && agent in CAMPAIGN_AGENTS) return { allow: true };
	return deny(
		"CG019",
		`${agent ? `Agent "${agent}"` : "A dispatch without an agent"} runs with a prompt the campaign does not control. Campaign dispatches use exactly these roles: campaign-worker to implement, campaign-reviewer to review, campaign-scout to investigate. Their prompts are owned and versioned with the guard; a builtin role's prompt is not, and the builtin reviewer will happily edit the tree it reviews.`,
		true,
	);
}

/**
 * Codes where the fix is to rewrite the dispatch itself. Those refusals carry the whole
 * contract, because the guard checks shape before it reads the prompt, so an agent that
 * fixes only what it was told still gets refused on the next phase for something it was
 * never shown. State refusals are excluded: the fix there is to do something else first,
 * and it is already named in the reason.
 */
const SHAPE_CODES = new Set(["CG002", "CG003", "CG004", "CG005", "CG009", "CG012", "CG013", "CG017", "CG019", "CG021", "CG022"]);

function dispatchContract(campaign: Campaign, agent: string | undefined, tiers: TierLists): string {
	return [
		"",
		"A dispatch that passes every check looks like this. The guard checks shape first and reads the prompt second, so satisfy all of it at once:",
		"",
		"  workflowScript: return runs.run('<key>', { agent: <role>, model: <pin>, task: <task> })  with async stated at top level",
		"  role:   campaign-worker | campaign-reviewer | campaign-scout, matching the work; a writer or reviewer is the only child of its script",
		"  tier:   class <1|2|3> for campaign-worker and campaign-scout, review <1|2> for campaign-reviewer",
		"",
		"  The tiers actually enforced right now, first entry preferred:",
		renderTiers(tiers),
		"  pin:    provider/model:effort            (a bare id or no model key is refused)",
		`  task:   ${routeShapeFor(agent)}`,
		"          Work in <worktree>. Writers and reviewers name the exact HEAD <sha> and stop if it differs; read-only investigations may omit it.",
		"          <what to do, and what done means>",
		"          Commit locally. Never push, never run gh, never open or comment on a PR.",
		"",
		`  <worktree> is ${campaign.worktree} or a lane worktree beside it, never /tmp or $TMPDIR.`,
		"  <sha> is a real sha you read before dispatching, not a placeholder. Any <angle-bracket> field left unrendered is refused.",
		"",
		"And it must not carry:",
		"  turnBudget, toolBudget, or maxTurns          bound liveness with elapsed time and serial milestones instead",
		"  an instruction to commit for you, push, rebase, cherry-pick, or touch PR state",
		"  review work before every slice is done and you have called coordinator_campaign action \"open-review\"",
		"  a model and effort outside the tier list for the class it declares",
	].join("\n");
}

/** The role a refusal is about, when the launch names exactly one. */
function contractRole(request: GuardRequest): string | undefined {
	const direct = request.input.agent;
	if (typeof direct === "string") return direct;
	const script = text(request.input.workflowScript);
	if (!script) return undefined;
	const { children } = parseScriptChildren(script);
	return children.length === 1 ? children[0].agent : undefined;
}

function withContract(decision: GuardDecision, campaign: Campaign | null, agent: string | undefined, tiers: TierLists): GuardDecision {
	if (decision.allow || !campaign) return decision;
	if (!SHAPE_CODES.has(decision.code) && !decision.teach) return decision;
	return { ...decision, reason: `${decision.reason}\n${dispatchContract(campaign, agent, tiers)}` };
}

export function evaluateStructure(request: GuardRequest): StructureDecision {
	const campaign = request.campaign && request.campaign.status !== "closed" ? request.campaign : null;
	const decision = evaluateStructureInner(request);
	return decision.allow ? decision : (withContract(decision, campaign, contractRole(request), request.tiers ?? DEFAULT_TIERS) as StructureDecision);
}

function evaluateStructureInner(request: GuardRequest): StructureDecision {
	const tiers = request.tiers ?? DEFAULT_TIERS;
	const config = request.config ?? DEFAULT_CONFIG;
	const { input, now } = request;
	// A closed campaign is history, not a live one: enforcement returns to inert so ordinary
	// work is not held hostage by a campaign that already ended.
	const campaign = request.campaign && request.campaign.status !== "closed" ? request.campaign : null;

	if (request.tool === "bash") {
		if (!campaign && !request.armed) return { allow: true, judge: [] };
		const verdict = checkBash(text(input.command), campaign);
		return verdict.allow ? { allow: true, judge: [] } : verdict;
	}

	// The campaign is the goal. A goal extension parks its objective when a turn ends in an
	// error, and a parked goal stops the continuation an unattended campaign runs on, so the
	// transition is refused while the ledger still says there is work to do.
	if (request.tool === "update_goal") {
		if (!campaign) return { allow: true, judge: [] };
		const status = text(input.status);
		if (status !== "blocked" && status !== "complete") return { allow: true, judge: [] };
		// Every slice counted is not the end. The mandatory final review runs after that, so a
		// goal that completes here stops the loop one step before the step that catches things.
		// A campaign that is genuinely over is closed, and a closed campaign leaves the guard
		// inert, so this refusal cannot outlive the work it protects.
		const open = campaign.lanes.filter((lane) => lane.state !== "integrated");
		const remaining = `${campaign.slicesDone} of ${campaign.slicesTotal} slices are recorded done`;
		const lanes = open.length > 0 ? `, and ${open.length} lane${open.length > 1 ? "s are" : " is"} still open` : "";
		return deny(
			"CG023",
			`Campaign ${campaign.slug} is still ${campaign.status}: ${remaining}${lanes}. Marking the goal ${status} stops the continuation that carries this campaign while you are away, and a transport error is not a finished campaign. Finish the work, run the final review, then end it deliberately with /campaign close.`,
		);
	}

	if (request.tool !== "subagent") return { allow: true, judge: [] };

	const action = text(input.action);
	if (isManagementAction(input)) {
		if (CORRECTION_ACTIONS.has(action) && campaign) {
			const runId = runIdOf(input);
			const used = campaign.steers[runId] ?? 0;
			if (runId && used >= config.steerCap) {
				return deny(
					"CG011",
					`Run ${runId} has already been corrected ${used} times, by steer or resume. Correcting past the cap is chaperoning, not coordinating: stop the run, split the remaining work into serial milestones, and re-dispatch with a fresh route. A run that needs a third correction is not converging.`,
				);
			}
		}
		return { allow: true, judge: [] };
	}

	if (action && (campaign || request.armed)) {
		// A schedule fires later, with no tool call to check, so nothing about that launch can
		// be enforced: not its status freshness, not the lane cap, not the review phase.
		if (/schedule/i.test(action) && campaign) {
			return deny(
				"CG016",
				`"${action}" defers work to a scheduler, and a run that starts without a tool call passes no check: not the status gate, not the lane cap, not the review phase. Dispatch the work directly when the campaign is ready for it.`,
			);
		}
		if (!isLaunch(input)) {
			// An unrecognised action may start or extend a run, and the guard cannot tell from
			// here. Refusing is the honest answer: a read-only one belongs in the management list.
			return deny(
				"CG016",
				`The guard cannot classify the action "${action}", so it cannot tell whether it starts work. If it launches or extends a run, dispatch it as a normal launch with a pinned model and a routing header. If it only inspects existing runs, add it to the guard's management list.`,
			);
		}
	}

	if (!isLaunch(input)) return { allow: true, judge: [] };

	if (!campaign) {
		if (!request.armed) return { allow: true, judge: [] };
		return deny(
			"CG001",
			'The coordinator skill is loaded but no campaign is registered, so no routing, lane, or status rule can be enforced. Call coordinator_campaign with action "start" (slug, worktree, plan path, slice count, authorization scope) before the first dispatch.',
		);
	}

	const script = text(input.workflowScript);
	const budgets = checkBudgets(input, script);
	if (!budgets.allow) return budgets;

	// Managed isolation is refused for a reason measured in this campaign: it branches the
	// child's worktree from the session cwd rather than the campaign worktree, and drops the
	// child in $TMPDIR under a path nobody knows at dispatch time. Both boundaries the guard
	// enforces then become unverifiable, because the prompt's named worktree is not where the
	// child wakes up and its expected HEAD is not what it finds. The one time it was used
	// here, three writers woke up on the session's main branch and correctly refused to work.
	if (input.worktree === true) {
		return deny(
			"CG021",
			`This launch asks the harness for a managed worktree. Managed isolation branches from the session's working directory, not from ${campaign.worktree}, and puts the child under $TMPDIR at a path that does not exist when you write the prompt. The named worktree and the expected HEAD then describe somewhere the child never goes.\n\nCreate the lane worktree yourself and name it:\n  git -C ${campaign.worktree} worktree add ${campaign.worktree.slice(0, campaign.worktree.lastIndexOf("/"))}/<lane>-<date> -b <branch> <base>\nthen dispatch with cwd set to that path and no worktree flag.`,
			true,
		);
	}

	// Knobs that swap what the child actually runs: an inline config or contract replaces
	// the role definition, agentScope excludes the guard's own agents directory, a skill
	// injects instructions the campaign never reviewed, and a forked or caught-up context
	// hands the child the coordinator's conversation. Each recreates the exact behavior the
	// campaign roles exist to prevent.
	const swappers = ["config", "agentContract", "agentScope", "scope", "skill"].filter((key) => input[key] !== undefined);
	if (text(input.context) === "fork") swappers.push("context: \"fork\"");
	if (text(input.catchUp) === "latest") swappers.push("catchUp: \"latest\"");
	if (swappers.length > 0) {
		return deny(
			"CG019",
			`This launch carries ${swappers.join(", ")}, which ${swappers.length > 1 ? "replace" : "replaces"} what the dispatched agent runs with or sees. A campaign dispatch is a campaign role, a pinned model, and a task: fresh context, no inline config, no scope override, no injected skill. Remove ${swappers.length > 1 ? "them" : "it"} and redispatch.`,
			true,
		);
	}

	const agent = typeof input.agent === "string" ? input.agent : undefined;
	if (agent && COORDINATOR_OWNED_AGENTS.has(agent.toLowerCase())) {
		return deny(
			"CG007",
			`Committing, pushing, PR state, and rebasing are coordinator-owned and are never dispatched. Run git yourself, then use the pr-ready skill. Dispatching agent "${agent}" hands a subagent write access to your branch to save one tool call.`,
		);
	}

	if (input.async === undefined) {
		return deny(
			"CG017",
			"State async explicitly on the launch. Whether a dispatch runs in the foreground depends on configuration and per-agent defaults, and a lane whose mode is guessed is either closed while its agent is still working or left open forever. Use async: true for a background lane you will close with coordinator_lane, or async: false to wait for it here.",
		);
	}

	// One target per child for a script, one for a plain dispatch. Each carries its own prompt,
	// because each child receives its own prompt.
	const targets: JudgeTarget[] = [];
	const seenKeys = new Set<string>();

	if (script) {
		const { children, agentKeys, defect } = parseScriptChildren(script);
		if (defect) {
			return deny(
				"CG002",
				`This script cannot be verified: ${defect} The guard reads what each child will launch from the literal call arguments, and a script it cannot read is a script it refuses.`,
				true,
			);
		}
		if (children.length === 0 || children.length !== agentKeys) {
			return deny(
				"CG002",
				`Write each child's agent, model, and task as literal fields in the script. ${agentKeys} agent entries were found but ${children.length} could be read as literal objects, and a child whose fields cannot be read is a child whose model was never pinned.`,
			);
		}
		for (const child of children) {
			// Same reason as the single-dispatch path: one refusal per problem is one round trip
			// per problem.
			const problems: Array<{ code: string; reason: string }> = [];
			const controlled = checkCampaignAgent(child.agent);
			if (!controlled.allow) problems.push({ code: controlled.code, reason: controlled.reason });
			if (child.worktree === true || child.worktree === "unreadable") {
				problems.push({
					code: "CG021",
					reason: `Child "${child.agent}" asks for a managed worktree, which branches from the session's working directory rather than ${campaign.worktree} and lands under $TMPDIR. Create the lane worktree yourself and pass cwd instead.`,
				});
			}
			if (child.context === "fork") {
				problems.push({
					code: "CG019",
					reason: `Child "${child.agent}" asks for context: "fork", which copies the coordinator's whole conversation into the child. Campaign children run on fresh context with an explicit task.`,
				});
			}
			if (parseModelPin(child.model) === null) {
				problems.push({
					code: "CG002",
					reason: `Child "${child.agent}" carries ${child.model ? `model ${child.model}` : "no literal model"}. Every child pins provider/model:effort, because an unpinned child inherits the session model and effort silently.`,
				});
			}
			const route = parseRouteHeader(child.task);
			if (!route) {
				problems.push({
					code: "CG003",
					reason: `Child "${child.agent}" has no ROUTE header. Every child carries its own routing row, exactly this shape:\n${routeShapeFor(child.agent)}`,
				});
			} else {
				if (route.model !== child.model) {
					problems.push({
						code: "CG004",
						reason: `Child "${child.agent}" declares ${route.model} in its routing header but launches with ${child.model}. Each child's header must describe that child's own launch.`,
					});
				}
				const routeCheck = checkRoute(route, child.agent, tiers);
				if (!routeCheck.allow) problems.push({ code: routeCheck.code, reason: routeCheck.reason });
			}
			if (problems.length > 0) return denyAll(problems);

			const declared = route as RouteHeader;
			const keyCheck = checkKey(declared.key, seenKeys, campaign);
			if (!keyCheck.allow) return keyCheck;
			targets.push({ routeKey: declared.key, prompt: child.task, agent: child.agent, declaredClass: declared.cls, model: child.model });
		}
	} else {
		// Collected rather than returned one at a time: each separate refusal costs the
		// coordinator a round trip, and a real campaign spent five of them on one dispatch.
		const problems: Array<{ code: string; reason: string }> = [];
		const controlled = checkCampaignAgent(agent);
		if (!controlled.allow) problems.push({ code: controlled.code, reason: controlled.reason });
		const pin = parseModelPin(input.model);
		if (!pin) {
			const seen = typeof input.model === "string" && input.model ? `"${input.model}"` : "nothing";
			problems.push({
				code: "CG002",
				reason: `Pin the model as provider/model:effort, for example openai-codex/gpt-5.6-luna:high. This launch carries ${seen}. A bare id inherits the role's own default effort, and no model key at all inherits the session model. The thinking field does not count as a pin.`,
			});
		}
		const task = text(input.task);
		const route = parseRouteHeader(task);
		if (!route) {
			problems.push({
				code: "CG003",
				reason: `Start the prompt with a routing header, exactly this shape and nothing else:\n${routeShapeFor(agent)}\nRouting is planned before and proved after. A dispatch with no declared row is an undecided one.`,
			});
		} else {
			if (route.model !== text(input.model)) {
				problems.push({
					code: "CG004",
					reason: `The routing header declares ${route.model} but the launch carries ${text(input.model)}. The table and the call must agree, or the table proves nothing.`,
				});
			}
			const routeCheck = checkRoute(route, agent, tiers);
			if (!routeCheck.allow) problems.push({ code: routeCheck.code, reason: routeCheck.reason });
		}
		if (problems.length > 0) return denyAll(problems);

		const declared = route as RouteHeader;
		const keyCheck = checkKey(declared.key, seenKeys, campaign);
		if (!keyCheck.allow) return keyCheck;
		targets.push({ routeKey: declared.key, prompt: task, agent, declaredClass: declared.cls, model: text(input.model) });
	}

	if (campaign.lastStatusAt !== null && now - campaign.lastStatusAt > config.statusMaxAgeMs) {
		const minutes = Math.floor((now - campaign.lastStatusAt) / 60_000);
		// A refusal that lists every reason it might be right teaches nothing. When a block was
		// read and rejected, the exact defect is known and is the only thing worth saying.
		const cause = campaign.lastStatusProblem
			? `The last status block was not counted, because ${campaign.lastStatusProblem}`
			: `The last status block was ${minutes} minutes ago`;
		return deny(
			"CG008",
			`${cause} Print the status block, then retry this launch in the same turn. Required fields: ${STATUS_FIELDS.join(", ")}.`,
		);
	}

	return { allow: true, judge: targets };
}

function checkKey(key: string, seen: Set<string>, campaign: Campaign): GuardDecision {
	if (seen.has(key)) {
		return deny("CG010", `Two children of this script share the route key ${key}. Each lane needs its own key, or its result cannot be recorded against the right one.`);
	}
	seen.add(key);
	const open = campaign.lanes.find((lane) => lane.key === key && lane.state !== "integrated");
	if (open) {
		return deny(
			"CG010",
			`You already dispatched ${key} and it is ${open.state}. Do not dispatch it again: you would redo work that has already happened.${open.note ? `\n\nWhat it returned: ${open.note}` : ""}\n\nReview what came back, then call coordinator_lane with action "integrated" and key "${key}" once it is on the campaign branch, or action "dead" if the run failed and you are abandoning it. Only then dispatch the next slice, under a new key.`,
		);
	}
	return { allow: true };
}

/**
 * Phase two: the decisions that depend on what the prompt says. The judge supplied the
 * reading; the rules are still here, and still deterministic.
 */
export function evaluateVerdicts(
	request: GuardRequest,
	judged: Array<{ target: JudgeTarget; verdict: PromptVerdict }>,
): GuardDecision {
	const active = request.campaign && request.campaign.status !== "closed" ? request.campaign : null;
	return withContract(evaluateVerdictsInner(request, judged), active, judged.length === 1 ? judged[0].target.agent : undefined, request.tiers ?? DEFAULT_TIERS);
}

function evaluateVerdictsInner(
	request: GuardRequest,
	judged: Array<{ target: JudgeTarget; verdict: PromptVerdict }>,
): GuardDecision {
	const config = request.config ?? DEFAULT_CONFIG;
	const tiers = request.tiers ?? DEFAULT_TIERS;
	const campaign = request.campaign && request.campaign.status !== "closed" ? request.campaign : null;
	if (!campaign) return { allow: true };

	// pi-subagents 0.43.0 removed direct execution, so a single-child script is the lane
	// vehicle, not a hidden fan-out. Only multi-child scripts are restricted to read-only
	// work: the one-writer-at-a-time rule lives in the lane cap and key accounting.
	const multiChild = judged.length > 1;
	let newWriters = 0;

	for (const { target, verdict } of judged) {
		const { kind } = verdict;

		if (multiChild && kind === "implement") {
			return deny(
				"CG010",
				`Child "${target.agent ?? target.routeKey}" is writer work inside a multi-child script. Writers go out one per dispatch, as the only child of its own script:\n\nworkflowScript: "return runs.run('<key>', { agent: 'campaign-worker', model: '<provider/model:effort>', task: ... })"\n\nDispatch the next writer only after this one returns and you record it with coordinator_lane action "integrated". A fan-out of writers is how five once opened in one instant and none landed for hours. Multi-child scripts are for independent read-only investigations.`,
				true,
			);
		}
		if (multiChild && kind === "review") {
			return deny(
				"CG006",
				`Child "${target.agent ?? target.routeKey}" is a review inside a multi-child script. Review is one dispatch, once, at the end: a single-child script dispatched as campaign-reviewer when the review phase opens.`,
				true,
			);
		}

		if (kind === "review") {
			if (campaign.status !== "review") {
				return deny(
					"CG006",
					`This dispatch reads as a review, and review runs once, at the end, after every slice is done: ${campaign.slicesDone} of ${campaign.slicesTotal} are. No code review per slice, whatever the prompt is labelled. Verify the slice against its acceptance criteria yourself and move on. When the last slice lands, call coordinator_campaign with action "open-review".`,
				);
			}
			const running = campaign.lanes.find((lane) => lane.kind === "review" && lane.state === "running");
			if (running) {
				return deny(
					"CG006",
					`Reviewer "${running.key}" is still running. One reviewer at a time: parallel reviewers produce overlapping findings and a reconciliation you cannot audit.`,
				);
			}
		}

		const expectedKind = target.agent ? CAMPAIGN_AGENTS[target.agent] : undefined;
		if (expectedKind && expectedKind !== kind) {
			return deny(
				"CG019",
				`This prompt reads as ${kind} work, but it is dispatched as ${target.agent}, whose role is to ${expectedKind}. The role's own instructions would fight the prompt. Dispatch it as ${Object.entries(CAMPAIGN_AGENTS).find(([, mapped]) => mapped === kind)?.[0] ?? "the matching role"} instead.`,
				true,
			);
		}

		// Position one is the default, not a suggestion. Reaching past it is allowed, because a
		// provider outage must not stall a campaign, but it costs the same sentence that
		// escalation does: otherwise "preferred" is silently ignorable, which is the shape of
		// rule this whole guard exists to replace.
		// Asked as its own question, because "why this class" and "why not the preferred model"
		// are different claims: a thorough cross-layer rationale is substantive and says
		// nothing at all about availability.
		const fallback = fallbackUsed(target, kind, tiers);
		if (fallback && verdict.modelUnavailability !== "stated") {
			return deny(
				"CG020",
				`${fallback.used} is a fallback for ${fallback.axis} ${fallback.cls}; the preferred model is ${fallback.preferred}. Reach past the preferred model only when it is unavailable, and say so in the routing reason, for example "claude-bridge rate-limited at 14:02". The reason on route ${target.routeKey} does not explain the choice.`,
				true,
			);
		}

		// The table could refuse reaching up and never noticed reaching down, so sustained
		// cross-component ownership was routed as "complete, mechanical slice" and admitted.
		// Under-tiering is the cheaper mistake to make and the more expensive one to discover:
		// the lane runs, and the work it was too small for comes back half done.
		// Scouts are tiered on the same implementation classes, and the review axis exists to
		// separate a routine branch from a broad one, so both are checked. Only the tier names
		// differ, which is why the needed value is read from an axis-specific map.
		const axis: "class" | "review" = kind === "review" ? "review" : "class";
		const needed =
			axis === "review"
				? ({ mechanical: 1, integration: 1, "cross-layer": 2 } as const)[verdict.describedScope]
				: ({ mechanical: 1, integration: 2, "cross-layer": 3 } as const)[verdict.describedScope];
		if (needed > target.declaredClass) {
			const meanings =
				axis === "review"
					? 'Review 1 is a routine branch; review 2 is a subtle, risky, broad, or cross-layer one.'
					: "Class 1 is a complete, mechanical slice; class 2 is prose-led or integration work; class 3 is cross-layer or long-horizon work.";
			return deny(
				"CG022",
				`Route ${target.routeKey} declares ${axis} ${target.declaredClass}, but its own reason describes ${verdict.describedScope} work, which is ${axis} ${needed}. Declare the tier the work needs, or write a reason that matches the tier you chose. ${meanings}`,
				true,
			);
		}

		// The top of either axis is the expensive, slow choice, so the judge reads the stated
		// reason and the guard refuses a label. Escalation should cost a sentence.
		const atTop = kind === "review" ? target.declaredClass === 2 : kind === "implement" && target.declaredClass === 3;
		if (atTop && verdict.classJustification !== "substantive") {
			const reads = verdict.classJustification === "label" ? "a label rather than a reason" : "no reason at all";
			return deny(
				"CG012",
				kind === "review"
					? `Review 2 is the top of the review table, so it needs a written reason naming what makes this branch subtle, risky, broad, or cross-layer. The reason on route ${target.routeKey} reads as ${reads}. A routine branch is review 1.`
					: `Class 3 implementation needs a written justification naming what makes the slice cross-layer or long-horizon. The reason on route ${target.routeKey} reads as ${reads}. Escalate exactly one class only when the task is complex or the lower class cannot make progress.`,
			);
		}

		if (verdict.coordinatorGitWork !== "none") {
			return deny(
				"CG007",
				`This prompt asks the subagent to ${verdict.coordinatorGitWork === "pr" ? "change pull request state" : verdict.coordinatorGitWork}. Committing locally is the agent's job; moving the branch is yours, even alongside real implementation work. Remove it and do that step yourself.`,
			);
		}

		if (verdict.unrenderedPlaceholders.length > 0) {
			return deny(
				"CG009",
				`The rendered prompt still contains ${verdict.unrenderedPlaceholders.map((entry) => `"${entry}"`).join(", ")}. One unset interpolation once shipped "cd undefined/<pkg>" to every agent in a fan-out under a header telling them the path was verified. Render every placeholder before launching.`,
			);
		}

		const lint = checkBoundaries(verdict, kind, campaign);
		if (!lint.allow) return lint;

		if (kind === "implement") newWriters += 1;
	}

	const cap = checkWriterCap(campaign, newWriters, config);
	if (!cap.allow) return cap;

	return { allow: true };
}

/**
 * The writer cap, shared by the judged path and the judge-off path. Turning the judge off
 * stops prompt rules; it does not hand back unlimited parallelism.
 */
export function checkWriterCap(campaign: Campaign, newWriters: number, config: GuardConfig = DEFAULT_CONFIG): GuardDecision {
	if (newWriters <= 0) return { allow: true };
	const open = campaign.lanes.filter((lane) => lane.kind === "implement" && lane.state !== "integrated");
	if (open.length + newWriters <= config.laneCap) return { allow: true };
	const awaiting = open.filter((lane) => lane.state === "returned").map((lane) => lane.key);
	return deny(
		"CG010",
		`${open.length} writer lanes are already open and the cap is ${config.laneCap}. ${
			awaiting.length > 0
				? `These returned but are not integrated yet: ${awaiting.join(", ")}. Integrate one into the campaign branch and record it with coordinator_lane action "integrated".`
				: "Wait for one to return and integrate it."
		} Parallel lanes that never integrate are integration debt, not progress.`,
	);
}

/** The boundaries every dispatched prompt has to carry, read out of the verdict. */
function checkBoundaries(verdict: PromptVerdict, kind: JudgedKind, campaign: Campaign): GuardDecision {
	const problems: Array<{ code: string; reason: string }> = [];
	const worktree = verdict.worktree;

	if (!worktree) {
		problems.push({
			code: "CG009",
			reason: `State the full resolved worktree path verbatim, and make it the campaign worktree ${campaign.worktree} or a lane worktree beside it. An agent spending turns rediscovering the environment is a dispatch defect, and an agent pointed at an unrelated tree is worse.`,
		});
	} else if (/^(\/tmp|\/private\/var\/folders|\/var\/folders)/.test(worktree)) {
		return deny(
			"CG013",
			`${worktree} is an ephemeral path. The worktree, the plan, the handoff doc, and the notes all live under ~/.agents/worktrees or the repo, never /tmp or $TMPDIR.`,
		);
	} else {
		const parent = campaign.worktree.slice(0, campaign.worktree.lastIndexOf("/") + 1);
		if (worktree !== campaign.worktree && !(parent.length > 1 && worktree.startsWith(parent))) {
			problems.push({
				code: "CG009",
				reason: `This prompt points the agent at ${worktree}, which is neither the campaign worktree ${campaign.worktree} nor a lane worktree beside it.`,
			});
		}
	}

	if (kind !== "investigate" && !verdict.expectedHead) {
		problems.push({
			code: "CG009",
			reason: 'Name the exact expected HEAD sha, as "at exact HEAD <sha>". Without it, a returned diff cannot be attributed to this dispatch.',
		});
	}
	if (kind === "implement" && !verdict.stopsOnHeadMismatch) {
		problems.push({
			code: "CG009",
			reason: "Tell the agent to stop and report if HEAD differs from the expected sha. A preflight with no instruction for the mismatch case is a sha the agent is free to ignore.",
		});
	}
	if (!verdict.forbidsPush) {
		problems.push({
			code: "CG009",
			reason: "The prompt must say the agent commits locally and never pushes, never runs gh, and never opens a PR. Pushing and PR state belong to the coordinator alone.",
		});
	}

	return problems.length === 0 ? { allow: true } : denyAll(problems);
}
