/**
 * Coordinator guard policy: harness-agnostic rules, pure functions only.
 *
 * Every rule here exists because a real campaign broke it while the skill text said
 * not to. Prose asks; this refuses. Each denial names the exact unblock action, so a
 * blocked call is one corrected retry away rather than a stall.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ImplementationClass = 1 | 2 | 3;
export type LaneKind = "implement" | "review" | "investigate";
export type LaneState = "running" | "returned" | "integrated";

export interface GuardConfig {
	statusMaxAgeMs: number;
	laneCap: number;
	steerCap: number;
	class3ReasonMinChars: number;
}

export const DEFAULT_CONFIG: GuardConfig = {
	statusMaxAgeMs: 5 * 60_000,
	laneCap: 3,
	steerCap: 2,
	class3ReasonMinChars: 30,
};

export interface Lane {
	key: string;
	kind: LaneKind;
	model: string;
	runId?: string;
	startedAt: number;
	state: LaneState;
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

export type GuardDecision = { allow: true } | { allow: false; code: string; reason: string };

const STATUS_FIELDS = ["CAMPAIGN", "SLICES", "PR", "AGENTS", "DIRECT", "NEXT"] as const;

const KIND_BY_AGENT: Record<string, LaneKind> = {
	worker: "implement",
	implementer: "implement",
	delegate: "implement",
	coder: "implement",
	reviewer: "review",
	"review-agent": "review",
	critic: "review",
	scout: "investigate",
	oracle: "investigate",
	advisor: "investigate",
	researcher: "investigate",
	planner: "investigate",
	"context-builder": "investigate",
};

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

export function contractPrompt(campaign: Campaign | null, armed: boolean, now: number, config: GuardConfig = DEFAULT_CONFIG): string {
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

- Every launch pins provider/model:effort. A bare id inherits the role default; no model key inherits the session model.
- Every launch opens with a routing header:
  ROUTE: <key> | class <1|2|3> | <provider/model:effort> | <why this class>
  Class 1 luna or sonnet, class 2 terra or opus, class 3 sol or fable. Class 3 implementation needs a real justification.
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

1. Check each running lane is actually alive with subagent action "status". A quiet agent is not a working agent, and a dispatch that returns nothing inside its liveness bound is a failed dispatch, not a slow one. Mark dead lanes with coordinator_lane action "dead".
2. Integrate any returned lane into the campaign branch yourself, run the gates yourself, and record it with coordinator_lane action "integrated".
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

export function modelClass(modelId: string): ImplementationClass | null {
	const id = modelId.toLowerCase();
	if (id.includes("luna") || id.includes("sonnet")) return 1;
	if (id.includes("terra")) return 2;
	if (id.includes("opus")) return 2;
	if (id.includes("sol") || id.includes("fable")) return 3;
	return null;
}

export function parseRouteHeader(text: string): RouteHeader | null {
	const match = /^[ \t>*-]*ROUTE:\s*(.+)$/im.exec(text);
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
	const missing = STATUS_FIELDS.filter((field) => !new RegExp(`^[ \\t>*-]*${field}\\b`, "im").test(text));
	return { ok: missing.length === 0, missing };
}

export function laneKindFor(agent: string | undefined, task: string): LaneKind {
	const known = agent ? KIND_BY_AGENT[agent.toLowerCase()] : undefined;
	const reviewish = /\b(review|reviewing|acceptance|adjudicate|findings|defect-first)\b/i.test(task);
	const implementish = /\b(implement|implementation|fix|repair|add|write|refactor|migrate|port|extract|build|compose)\b/i.test(task);
	if (reviewish && !implementish) return "review";
	if (known) return known;
	return implementish ? "implement" : "investigate";
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function firstInstruction(task: string): string {
	for (const line of task.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || /^[ \t>*-]*ROUTE:/i.test(trimmed)) continue;
		return trimmed;
	}
	return "";
}

function isManagementAction(input: Record<string, unknown>): boolean {
	return typeof input.action === "string" && input.action.length > 0;
}

function isLaunch(input: Record<string, unknown>): boolean {
	if (isManagementAction(input)) return false;
	return typeof input.agent === "string" || text(input.workflowScript).length > 0;
}

function deny(code: string, reason: string): GuardDecision {
	return { allow: false, code, reason };
}

function checkBash(command: string): GuardDecision {
	const spawn = /(^|[\s;&|(])((codex\s+(exec|resume))|(claude\s+(-p|--print))|(pi\s+(-p|--prompt|exec))|(npx\s+(-y\s+)?pi\b))/i;
	if (spawn.test(command)) {
		return deny(
			"CG014",
			"Spawning an agent through bash bypasses every dispatch rule. Use the subagent tool so the routing table, model pin, and lane accounting apply. If this genuinely is not a dispatch, rename the command.",
		);
	}
	const destructive: Array<[RegExp, string]> = [
		[/git\s+reset\s+--hard/i, "git reset --hard"],
		[/git\s+stash(\s|$)/i, "git stash"],
		[/git\s+restore(\s|$)/i, "git restore"],
		[/git\s+checkout\s+--\s/i, "git checkout -- <path>"],
		[/git\s+push\s+(.*\s)?(--force|-f)(\s|$)/i, "git push --force"],
		[/git\s+worktree\s+remove\s+.*--force/i, "git worktree remove --force"],
	];
	for (const [pattern, label] of destructive) {
		if (pattern.test(command)) {
			return deny(
				"CG015",
				`${label} discards work with no prompt and a backup branch does not save uncommitted changes. To move a branch pointer use git switch -C <branch> <sha> or git update-ref. If you truly need a clean tree, commit or export first and say so in the status block.`,
			);
		}
	}
	return { allow: true };
}

function collectScriptModels(script: string): { agents: number; models: string[] } {
	const agents = script.match(/\bagent\s*:/g)?.length ?? 0;
	const models = [...script.matchAll(/\bmodel\s*:\s*['"`]([^'"`]+)['"`]/g)].map((match) => match[1]);
	return { agents, models };
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

export function evaluate(request: GuardRequest): GuardDecision {
	const config = request.config ?? DEFAULT_CONFIG;
	const { input, now } = request;
	// A closed campaign is history, not a live one: enforcement returns to inert so ordinary
	// work is not held hostage by a campaign that already ended.
	const campaign = request.campaign && request.campaign.status !== "closed" ? request.campaign : null;

	if (request.tool === "bash") {
		if (!campaign && !request.armed) return { allow: true };
		return checkBash(text(input.command));
	}

	if (request.tool !== "subagent") return { allow: true };

	if (isManagementAction(input)) {
		if (input.action === "steer" && campaign) {
			const runId = text(input.runId);
			const used = campaign.steers[runId] ?? 0;
			if (runId && used >= config.steerCap) {
				return deny(
					"CG011",
					`Run ${runId} has already been steered ${used} times. Steering past the cap is chaperoning, not coordinating: stop the run, split the remaining work into serial milestones, and re-dispatch with a fresh route. A run that needs a third correction is not converging.`,
				);
			}
		}
		return { allow: true };
	}

	if (!isLaunch(input)) return { allow: true };

	if (!campaign) {
		if (!request.armed) return { allow: true };
		return deny(
			"CG001",
			"The coordinator skill is loaded but no campaign is registered, so no routing, lane, or status rule can be enforced. Call coordinator_campaign with action \"start\" (slug, worktree, plan path, slice count, authorization scope) before the first dispatch.",
		);
	}

	const script = text(input.workflowScript);
	const budgets = checkBudgets(input, script);
	if (!budgets.allow) return budgets;

	if (script) {
		const { agents, models } = collectScriptModels(script);
		const unpinned = models.filter((model) => parseModelPin(model) === null);
		if (models.length < agents || unpinned.length > 0) {
			return deny(
				"CG002",
				`Every agent in a workflow script needs its own model pinned as provider/model:effort. Found ${agents} agent entries and ${models.length} model values${unpinned.length > 0 ? `, and these carry no valid effort suffix: ${unpinned.join(", ")}` : ""}. An unpinned entry inherits the session model and effort silently.`,
			);
		}
	}

	const task = text(input.task) || script;
	const agent = typeof input.agent === "string" ? input.agent : undefined;

	if (agent && COORDINATOR_OWNED_AGENTS.has(agent.toLowerCase())) {
		return deny(
			"CG007",
			`Committing, pushing, PR state, and rebasing are coordinator-owned and are never dispatched. Run git yourself, then use the pr-ready skill. Dispatching agent "${agent}" hands a subagent write access to your branch to save one tool call.`,
		);
	}
	const gitWrite = /\b(commit|commits|committing|stage|staged|staging|rebase|cherry-pick|push)\b/i;
	const realWork = /\b(implement|implementation|fix|repair|add|write|refactor|migrate|port|extract|design|review|audit|investigate|inventory|analy[sz]e|research|reconnaissance|compose)\b/i;
	if (gitWrite.test(task) && !realWork.test(task)) {
		return deny(
			"CG007",
			"This dispatch is git plumbing with no implementation in it. Committing, staging, rebasing, pushing, and PR state belong to the coordinator alone: run git yourself. Handing a subagent write access to your branch to save one tool call is a bad trade every time.",
		);
	}
	if (/^[ \t>*-]*(commit|stage|push|rebase|open (a |the )?pr)\b/i.test(firstInstruction(task))) {
		return deny(
			"CG007",
			"The assignment line of this prompt begins with a git action. If a dispatch prompt you are writing begins with \"commit\", stop and run git yourself.",
		);
	}
	if (/\bgit push\b|\bgh pr (create|edit|merge|comment)\b/i.test(task) && !/\b(never|do not|don't|no)\s+(push|run gh)/i.test(task)) {
		return deny(
			"CG007",
			"This prompt tells a subagent to push or to change PR state. Pushing and PR state belong to the coordinator alone. Remove it, and state that the agent commits locally and never pushes.",
		);
	}

	if (!script) {
		const pin = parseModelPin(input.model);
		if (!pin) {
			const seen = typeof input.model === "string" && input.model ? `"${input.model}"` : "nothing";
			return deny(
				"CG002",
				`Pin the model as provider/model:effort, for example openai-codex/gpt-5.6-luna:high. This launch carries ${seen}. A bare id inherits the role's own default effort, and no model key at all inherits the session model. The thinking field does not count as a pin.`,
			);
		}
	}

	const route = parseRouteHeader(task);
	if (!route) {
		return deny(
			"CG003",
			"Start the prompt with a routing header, then the guard records it as the routing-table row for this dispatch:\nROUTE: <key> | class <1|2|3> | <provider/model:effort> | <why this class>\nRouting is planned before and proved after. A dispatch with no declared row is an undecided one.",
		);
	}

	const pinnedModel = script ? route.model : text(input.model);
	if (!script && route.model !== pinnedModel) {
		return deny(
			"CG004",
			`The routing header declares ${route.model} but the launch carries ${pinnedModel}. The table and the call must agree, or the table proves nothing.`,
		);
	}

	const pin = parseModelPin(route.model);
	if (!pin) {
		return deny("CG004", `The routing header model ${route.model} is not pinned as provider/model:effort.`);
	}
	const actualClass = modelClass(pin.id);
	if (actualClass === null) {
		return deny(
			"CG004",
			`${pin.id} is not in the tier table, so its class cannot be checked. Add it to the table or route to a listed model.`,
		);
	}
	if (actualClass !== route.cls) {
		return deny(
			"CG004",
			`The header declares class ${route.cls} but ${pin.id} is class ${actualClass} in the tier table. Fix whichever is wrong: choosing a class is choosing a model, not a label.`,
		);
	}

	const kind = laneKindFor(agent, task);

	if (kind === "implement" && route.cls === 3 && route.reason.length < config.class3ReasonMinChars) {
		return deny(
			"CG012",
			`Class 3 implementation needs a written justification of at least ${config.class3ReasonMinChars} characters saying what makes the slice cross-layer or long-horizon; "${route.reason}" is a label. Escalate exactly one class only when the task is complex or the lower class cannot make progress.`,
		);
	}

	if (kind === "review") {
		if (campaign.status !== "review") {
			return deny(
				"CG006",
				`Review runs once, at the end, after every slice is done: ${campaign.slicesDone} of ${campaign.slicesTotal} are. No code review per slice. Verify the slice against its acceptance criteria yourself and move on. When the last slice lands, call coordinator_campaign with action "open-review".`,
			);
		}
		const runningReview = campaign.lanes.find((lane) => lane.kind === "review" && lane.state === "running");
		if (runningReview) {
			return deny(
				"CG006",
				`Reviewer "${runningReview.key}" is still running. One reviewer at a time: parallel reviewers produce overlapping findings and a reconciliation you cannot audit.`,
			);
		}
	}

	if (campaign.lastStatusAt !== null && now - campaign.lastStatusAt > config.statusMaxAgeMs) {
		const minutes = Math.floor((now - campaign.lastStatusAt) / 60_000);
		return deny(
			"CG008",
			`The last status block was ${minutes} minutes ago. Print the status block, then retry this launch in the same turn. Required fields: ${STATUS_FIELDS.join(", ")}, plus WORKTREE, PARKED, and NEEDS YOU.`,
		);
	}

	const lint = lintPrompt(task, kind);
	if (!lint.allow) return lint;

	if (kind === "implement") {
		const open = campaign.lanes.filter((lane) => lane.kind === "implement" && lane.state !== "integrated");
		if (open.length >= config.laneCap) {
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
	}

	return { allow: true };
}

function lintPrompt(task: string, kind: LaneKind): GuardDecision {
	const placeholder = /\b(undefined|null|NaN)\b|\[[A-Z][A-Z _-]{3,}\]|\$\{[^}]*\}/;
	const found = placeholder.exec(task);
	if (found) {
		return deny(
			"CG009",
			`The rendered prompt still contains "${found[0]}". One unset interpolation once shipped "cd undefined/<pkg>" to every agent in a fan-out under a header telling them the path was verified. Render every placeholder before launching.`,
		);
	}

	const paths = task.match(/(^|\s)(\/[\w./-]+)/g)?.map((match) => match.trim()) ?? [];
	const ephemeral = paths.find((path) => /^(\/tmp|\/private\/var\/folders|\/var\/folders)/.test(path));
	if (ephemeral) {
		return deny(
			"CG013",
			`${ephemeral} is an ephemeral path. The worktree, the plan, the handoff doc, and the notes all live under ~/.agents/worktrees or the repo, never /tmp or $TMPDIR.`,
		);
	}

	const hasWorktree = paths.some((path) => path.split("/").length >= 3);
	if (!hasWorktree) {
		return deny(
			"CG009",
			"State the full resolved worktree path verbatim in the prompt. An agent spending turns rediscovering the environment is a dispatch defect, not agent initiative.",
		);
	}

	if (kind !== "investigate" && !/\b(?=[0-9a-f]{7,40}\b)[0-9a-f]*[a-f][0-9a-f]*\b/i.test(task)) {
		return deny(
			"CG009",
			"State the exact expected HEAD sha and tell the agent to stop and report if it differs. Without it, a returned diff cannot be attributed.",
		);
	}

	if (!/\b(never|do not|don't|no)\s+push\b/i.test(task)) {
		return deny(
			"CG009",
			"The prompt must say the agent commits locally and never pushes, never runs gh, and never opens a PR. Pushing and PR state belong to the coordinator alone.",
		);
	}

	return { allow: true };
}
