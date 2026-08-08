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

import type { JudgedKind, PromptVerdict } from "./judge.ts";

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
	lastStatusAt: number | null;
	startedAt: number;
}

export interface RouteHeader {
	key: string;
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
}

export type GuardDecision = { allow: true } | { allow: false; code: string; reason: string; teach?: boolean };

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
		startedAt: init.startedAt,
	};
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
): string {
	const campaign = liveOrClosed && liveOrClosed.status !== "closed" ? liveOrClosed : null;
	if (!campaign) {
		if (!armed) return "";
		return `Coordinator guard: armed, no campaign registered.

The coordinator skill is loaded, so dispatches are blocked until you call coordinator_campaign with action "start" (slug, worktree, plan_path, slices_total, authorized). Registering the campaign is what makes routing, lane, and status enforcement possible.`;
	}

	const staleMinutes = campaign.lastStatusAt === null ? null : Math.floor((now - campaign.lastStatusAt) / 60_000);
	const openLanes = campaign.lanes.filter((lane) => lane.state !== "integrated");

	return `Coordinator guard: campaign ${campaign.slug} is ${campaign.status}.

Worktree: ${campaign.worktree}
Plan: ${campaign.planPath ?? "unrecorded"}
Slices: ${campaign.slicesDone} done of ${campaign.slicesTotal}
Open lanes: ${laneSummary(campaign)}
Last status block: ${staleMinutes === null ? "never" : `${staleMinutes} minutes ago`}

AUTHORIZED      ${campaign.authorized}
NOT AUTHORIZED  merge; close or reopen PRs; publish releases; touch production; force-push over shared history; delete outside the named scope

These are enforced at the tool boundary, not by your memory of them. A dispatch that breaks one fails:

- Every launch pins provider/model:effort, and only these pairs route. Anything else is refused:
${tierTable()}
- Every launch opens with a routing header, and its model must match what the call carries:
  ROUTE: <key> | class <1|2|3> | <provider/model:effort> | <why this class>
  Class 3 implementation needs a real justification, not the word "complex".
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

/**
 * The tier table as pairs, because the table lists a model AND the effort to run it at:
 * a class is a model at an effort, not a model. sol and fable also carry the review tier
 * at high, which is why they list two efforts.
 */
const TIERS: Array<{ family: RegExp; label: string; efforts: Partial<Record<ThinkingLevel, ImplementationClass>> }> = [
	{ family: /luna/, label: "gpt-5.6-luna", efforts: { high: 1 } },
	{ family: /sonnet/, label: "claude-sonnet", efforts: { medium: 1 } },
	{ family: /terra/, label: "gpt-5.6-terra", efforts: { medium: 2 } },
	{ family: /opus/, label: "claude-opus", efforts: { low: 2, medium: 3 } },
	{ family: /sol/, label: "gpt-5.6-sol", efforts: { medium: 3, high: 3 } },
	{ family: /fable/, label: "claude-fable", efforts: { high: 3 } },
];

/** Every routable model and effort, so a refusal names the choices instead of implying them. */
function tierTable(): string {
	return TIERS.flatMap((tier) =>
		Object.entries(tier.efforts).map(([effort, cls]) => `  class ${cls}  ${tier.label}:${effort}`),
	).join("\n");
}

function tierFor(modelId: string) {
	const id = modelId.toLowerCase();
	return TIERS.find((tier) => tier.family.test(id));
}

export function modelClass(modelId: string, effort: ThinkingLevel): ImplementationClass | null {
	return tierFor(modelId)?.efforts[effort] ?? null;
}

/** The efforts the table lists for a model, for the refusal to quote back. */
export function listedEfforts(modelId: string): ThinkingLevel[] {
	const tier = tierFor(modelId);
	return tier ? (Object.keys(tier.efforts) as ThinkingLevel[]) : [];
}

export function parseRouteHeader(text: string): RouteHeader | null {
	// Line-anchored for a plain prompt, and after a quote or backtick for a child inside a script.
	const match = /(?:^|[`'"])[ \t>*-]*ROUTE:\s*(.+)$/im.exec(text);
	if (!match) return null;
	const parts = match[1].split("|").map((part) => part.trim());
	if (parts.length < 4) return null;
	const classMatch = /^class\s*([123])$/i.exec(parts[1]);
	if (!classMatch) return null;
	return {
		key: parts[0],
		cls: Number(classMatch[1]) as ImplementationClass,
		model: parts[2],
		reason: parts.slice(3).join(" | ").trim(),
	};
}

export function readStatusBlock(text: string): { ok: boolean; missing: string[] } {
	// Validate the block itself, not the prose around it: a message that happens to mention a
	// PR elsewhere must not make an incomplete block look fresh. Fields share lines in the real
	// layout (CAMPAIGN sits beside WORKTREE), so labels are matched within the block region.
	const lines = text.split("\n");
	const start = lines.findIndex((line) => /^[ \t>*-]*CAMPAIGN\b/i.test(line));
	if (start === -1) return { ok: false, missing: [...STATUS_FIELDS] };
	let end = lines.findIndex((line, index) => index >= start && /^[ \t>*-]*NEXT\b/i.test(line));
	if (end === -1) end = Math.min(lines.length - 1, start + STATUS_FIELDS.length + 4);
	const block = lines.slice(start, end + 1).join("\n");
	const missing = STATUS_FIELDS.filter((field) => !new RegExp(`\\b${field}\\b`, "i").test(block));
	return { ok: missing.length === 0, missing };
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

function deny(code: string, reason: string, teach = false): GuardDecision {
	return { allow: false, code, reason, ...(teach ? { teach: true } : {}) };
}

/**
 * One refusal listing every problem found, because revealing them one at a time costs a
 * round trip each. A real campaign spent five attempts and two minutes on its first
 * dispatch, learning one rule per refusal.
 */
function denyAll(problems: Array<{ code: string; reason: string }>): GuardDecision {
	if (problems.length === 1) return deny(problems[0].code, problems[0].reason);
	const list = problems.map((problem, index) => `${index + 1}. [${problem.code}] ${problem.reason}`).join("\n\n");
	return deny(problems[0].code, `This launch has ${problems.length} problems. Fix them together and retry once:\n\n${list}`);
}

function checkBash(command: string): GuardDecision {
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
		"rewrites published history, which is outside the recorded authorization and can destroy work that is not yours. Ask the user before any force push, naming the exact branch.";
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
		if (pattern.test(command)) return deny("CG015", `${label} ${reason}`);
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
	const child = { agent, model: readField(body, "model") ?? "", task: readField(body, "task") ?? "", context: readField(body, "context") };
	children.push(child);
	return child;
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
function readField(objectBody: string, field: string): string | undefined {
	const key = new RegExp(`(?:^|[{,\\s])["']?${field}["']?\\s*:`, "i");
	const found = key.exec(objectBody);
	if (!found) return undefined;
	const rest = objectBody.slice(found.index + found[0].length).trimStart();
	const quote = rest[0];
	if (quote !== "'" && quote !== '"' && quote !== "`") return "";
	let value = "";
	for (let index = 1; index < rest.length; index++) {
		const char = rest[index];
		if (char === "\\") {
			value += rest[index + 1] === "n" ? "\n" : rest[index + 1];
			index++;
			continue;
		}
		if (char === quote) return value;
		value += char;
	}
	return undefined;
}

/** Model pin and declared class, checked the same way for a lone dispatch and for a child. */
function checkRoute(route: RouteHeader): GuardDecision {
	const pin = parseModelPin(route.model);
	if (!pin) return deny("CG004", `The routing header model ${route.model} is not pinned as provider/model:effort.`);
	const actualClass = modelClass(pin.id, pin.effort);
	if (actualClass === null) {
		const listed = listedEfforts(pin.id);
		if (listed.length > 0) {
			return deny(
				"CG004",
				`The tier table lists ${pin.id} at ${listed.join(" or ")} effort, not ${pin.effort}. A class is a model at an effort, so running a listed model at an unlisted effort is not the tier you declared.`,
			);
		}
		return deny(
			"CG004",
			`${pin.id} is not in the tier table, so its class cannot be checked. Route to one of these exactly, model and effort together:\n${tierTable()}\nThe provider prefix stays as your harness spells it, for example openai-codex/gpt-5.6-luna:high.`,
		);
	}
	if (actualClass !== route.cls) {
		return deny(
			"CG004",
			`Route ${route.key} declares class ${route.cls} but ${pin.id} at ${pin.effort} is class ${actualClass} in the tier table. Fix whichever is wrong: choosing a class is choosing a model, not a label.`,
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
const SHAPE_CODES = new Set(["CG002", "CG003", "CG004", "CG005", "CG009", "CG012", "CG013", "CG017", "CG019"]);

function dispatchContract(campaign: Campaign): string {
	return [
		"",
		"A dispatch that passes every check looks like this. The guard checks shape first and reads the prompt second, so satisfy all of it at once:",
		"",
		"  workflowScript: return runs.run('<key>', { agent: <role>, model: <pin>, task: <task> })  with async stated at top level",
		"  role:   campaign-worker | campaign-reviewer | campaign-scout, matching the work; a writer or reviewer is the only child of its script",
		"  pin:    provider/model:effort            (a bare id or no model key is refused)",
		"  task:   ROUTE: <key> | class <1|2|3> | <provider/model:effort> | <why this class>",
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
		"  a class the model does not match: class 1 luna or sonnet, class 2 terra or opus, class 3 sol or fable",
	].join("\n");
}

function withContract(decision: GuardDecision, campaign: Campaign | null): GuardDecision {
	if (decision.allow || !campaign) return decision;
	if (!SHAPE_CODES.has(decision.code) && !decision.teach) return decision;
	return { ...decision, reason: `${decision.reason}\n${dispatchContract(campaign)}` };
}

export function evaluateStructure(request: GuardRequest): StructureDecision {
	const campaign = request.campaign && request.campaign.status !== "closed" ? request.campaign : null;
	const decision = evaluateStructureInner(request);
	return decision.allow ? decision : (withContract(decision, campaign) as StructureDecision);
}

function evaluateStructureInner(request: GuardRequest): StructureDecision {
	const config = request.config ?? DEFAULT_CONFIG;
	const { input, now } = request;
	// A closed campaign is history, not a live one: enforcement returns to inert so ordinary
	// work is not held hostage by a campaign that already ended.
	const campaign = request.campaign && request.campaign.status !== "closed" ? request.campaign : null;

	if (request.tool === "bash") {
		if (!campaign && !request.armed) return { allow: true, judge: [] };
		const verdict = checkBash(text(input.command));
		return verdict.allow ? { allow: true, judge: [] } : verdict;
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
					reason: `Child "${child.agent}" has no ROUTE header. Every child carries its own routing row, exactly this shape:\nROUTE: <key> | class <1|2|3> | <provider/model:effort> | <why this class>`,
				});
			} else {
				if (route.model !== child.model) {
					problems.push({
						code: "CG004",
						reason: `Child "${child.agent}" declares ${route.model} in its routing header but launches with ${child.model}. Each child's header must describe that child's own launch.`,
					});
				}
				const routeCheck = checkRoute(route);
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
				reason: "Start the prompt with a routing header, exactly this shape and nothing else:\nROUTE: <key> | class <1|2|3> | <provider/model:effort> | <why this class>\nRouting is planned before and proved after. A dispatch with no declared row is an undecided one.",
			});
		} else {
			if (route.model !== text(input.model)) {
				problems.push({
					code: "CG004",
					reason: `The routing header declares ${route.model} but the launch carries ${text(input.model)}. The table and the call must agree, or the table proves nothing.`,
				});
			}
			const routeCheck = checkRoute(route);
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
		return deny(
			"CG008",
			`The last status block was ${minutes} minutes ago. Print the status block, then retry this launch in the same turn. Required fields: ${STATUS_FIELDS.join(", ")}.`,
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
	return withContract(evaluateVerdictsInner(request, judged), active);
}

function evaluateVerdictsInner(
	request: GuardRequest,
	judged: Array<{ target: JudgeTarget; verdict: PromptVerdict }>,
): GuardDecision {
	const config = request.config ?? DEFAULT_CONFIG;
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

		if (kind === "implement" && target.declaredClass === 3 && verdict.classJustification !== "substantive") {
			return deny(
				"CG012",
				`Class 3 implementation needs a written justification naming what makes the slice cross-layer or long-horizon. The reason on route ${target.routeKey} reads as ${verdict.classJustification === "label" ? "a label rather than a reason" : "no reason at all"}. Escalate exactly one class only when the task is complex or the lower class cannot make progress.`,
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
