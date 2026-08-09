/**
 * Coordinator guard, pi harness wiring.
 *
 * The coordinator skill is prose, and prose decays: in a 19 hour campaign the rules were
 * quoted correctly in hour one and gone by hour three, for roughly seventy dispatches.
 * This extension turns the mechanical half of that skill into refusals at the tool
 * boundary, restates the contract every turn, and refuses to let the session go quiet
 * while agents are in flight.
 */

import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { complete, completeSimple } from "@earendil-works/pi-ai/compat";
import type { Model, ThinkingLevel, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { delimiter as pathDelimiter } from "node:path";
import { fileURLToPath } from "node:url";

import { judgeCacheKey, judgeDispatch, type JudgeCall, type PromptVerdict } from "./judge.ts";
import { findRoleShadows } from "./shadows.ts";
import { rateFor, readThroughput, reorderByThroughput, type Throughput } from "./throughput.ts";

import {
	continuationDecision,
	continuationPrompt,
	contractPrompt,
	checkWriterCap,
	evaluateStructure,
	evaluateVerdicts,
	isManagementAction,
	laneSummary,
	newCampaign,
	openReview,
	DEFAULT_TIERS,
	GPT_DEFAULT_TIERS,
	CLAUDE_DEFAULT_TIERS,
	parseModelPin,
	findTierClash,
	parseTierEntries,
	recordIntegration,
	renderTiers,
	withTierList,
	parseRouteHeader,
	readStatusBlock,
	statusBlockDisagreement,
	type Campaign,
	type JudgeTarget,
	type TierLists,
} from "./policy.ts";

const STATE_TYPE = "coordinator-guard";
/** The judge's own transcript card: what it read, what it answered, and what that cost. */
const JUDGE_ENTRY_TYPE = "coordinator-guard-judge";

interface JudgeCard {
	model: string;
	effort: string;
	elapsedMs: number;
	cached: number;
	outcome: { allowed: true } | { allowed: false; code: string; reason: string };
	targets: Array<{
		routeKey: string;
		agent?: string;
		declaredClass: number;
		fromCache: boolean;
		verdict: PromptVerdict;
	}>;
}
const NOTICE_TYPE = "coordinator-guard-notice";
const CONTINUATION_TYPE = "coordinator-guard-continuation";

/** A continuation costs a turn, so it is rate limited to the status cadence rather than fired per idle turn. */
const CONTINUATION_INTERVAL_MS = 5 * 60_000;
/** After this many continuations with no lane changing state, the campaign is stuck and the user decides. */
const MAX_NO_PROGRESS_CONTINUATIONS = 10;

/**
 * The judge reads prompts, so it wants to be cheap and fast rather than clever. It is
 * overridable because model availability is a local fact, not something this can assume.
 */
const DEFAULT_JUDGE_MODEL = "openai-codex/gpt-5.6-luna:low";
const CLAUDE_JUDGE_MODEL = "claude-bridge/claude-sonnet-5:low";
const JUDGE_MAX_TOKENS = 700;

/** Mirrors the policy's correction actions, for counting what the guard already allowed. */
const CORRECTION_ACTIONS = new Set(["steer", "resume"]);

interface PersistedState {
	version: 1;
	armed: boolean;
	campaign: Campaign | null;
	judgeModel: string;
	judgeEnabled: boolean;
	/** Absent until the user overrides a class, so defaults keep evolving with the code. */
	tiers?: TierLists;
}

const StartParams = Type.Object({
	action: Type.Union([
		Type.Literal("start"),
		Type.Literal("open-review"),
		Type.Literal("close"),
		Type.Literal("set-slices"),
		Type.Literal("show"),
	]),
	slug: Type.Optional(Type.String({ description: "Campaign slug, required for start." })),
	worktree: Type.Optional(Type.String({ description: "Full resolved worktree path, required for start." })),
	plan_path: Type.Optional(Type.String({ description: "Path to the approved plan file." })),
	slices_total: Type.Optional(Type.Number({ description: "Total slices in the approved plan." })),
	slices_done: Type.Optional(Type.Number({ description: "Slices finished so far, for set-slices." })),
	authorized: Type.Optional(Type.String({ description: "The authorization scope the user granted, verbatim." })),
});

const LaneParams = Type.Object({
	action: Type.Union([Type.Literal("returned"), Type.Literal("integrated"), Type.Literal("done"), Type.Literal("dead")]),
	key: Type.String({ description: "The ROUTE key of the lane." }),
	slice: Type.Optional(
		StringEnum(["done", "retry", "partial"] as const, {
			description:
				'Required when integrating a writer lane. "done" finishes a slice and advances the count, "retry" re-ran a slice already counted, "partial" landed work the slice still needs more of.',
		}),
	),
	note: Type.Optional(Type.String()),
});

/** The verdict as display rows, in the order the judge is asked. */
/** Restored state is data from disk, so its shape is checked before it becomes policy. */
function isTierLists(value: unknown): value is TierLists {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { class?: unknown; review?: unknown };
	const listsOk = (lists: unknown, keys: string[]) => {
		if (!lists || typeof lists !== "object") return false;
		const record = lists as Record<string, unknown>;
		return keys.every((key) => Array.isArray(record[key]) && (record[key] as unknown[]).every((entry) => typeof entry === "string"));
	};
	return listsOk(candidate.class, ["1", "2", "3"]) && listsOk(candidate.review, ["1", "2"]);
}

function verdictRows(verdict: PromptVerdict): Array<[string, string]> {
	return [
		["kind", verdict.kind],
		["worktree", verdict.worktree ?? "not stated"],
		["expected HEAD", verdict.expectedHead ?? "not stated"],
		["stops on mismatch", verdict.stopsOnHeadMismatch ? "yes" : "no"],
		["forbids push", verdict.forbidsPush ? "yes" : "no"],
		["coordinator git work", verdict.coordinatorGitWork],
		["placeholders", verdict.unrenderedPlaceholders.length > 0 ? verdict.unrenderedPlaceholders.join(", ") : "none"],
		["class justification", verdict.classJustification],
	];
}

function firstLine(reason: string): string {
	const line = reason.split("\n").find((entry) => entry.trim().length > 0) ?? "";
	return line.length > 90 ? `${line.slice(0, 87)}...` : line;
}

export default function coordinatorGuard(pi: ExtensionAPI) {
	// The campaign roles live beside the guard and are registered with pi-subagents through
	// its extra-dirs env, which it reads at dispatch time. This is what lets the guard own
	// what a dispatched agent is told, rather than the builtin role prose.
	const agentsDir = fileURLToPath(new URL("./agents/", import.meta.url)).replace(/\/$/, "");
	let roleShadowCache: string[] | null = null;
	const registered = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS?.split(pathDelimiter).filter(Boolean) ?? [];
	if (!registered.includes(agentsDir)) {
		process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = [...registered, agentsDir].join(pathDelimiter);
	}

	let campaign: Campaign | null = null;
	let armed = false;
	let judgeModel = DEFAULT_JUDGE_MODEL;
	let judgeEnabled = true;
	let tiers: TierLists = DEFAULT_TIERS;
	const verdictCache = new Map<string, PromptVerdict>();
	let noProgressContinuations = 0;
	/** Errored turns in a row, so a failing provider stops the campaign but one blip does not. */
	let consecutiveErrors = 0;
	let lastContinuationAt = 0;
	let continuationQueued = false;
	let continuationTimer: ReturnType<typeof setTimeout> | null = null;
	const laneByToolCall = new Map<string, { keys: string[]; foreground: boolean }>();

	function recordProgress(): void {
		noProgressContinuations = 0;
		// A streak belongs to one stretch of work. Carrying it across a resume or a new
		// campaign would let two old failures make the next campaign's first error the last.
		consecutiveErrors = 0;
	}

	/** A background launch answers with its run id; keeping it makes status and stop unambiguous. */
	function backgroundRunId(details: unknown): string | undefined {
		if (!details || typeof details !== "object") return undefined;
		const record = details as Record<string, unknown>;
		for (const key of ["runId", "id"]) {
			const value = record[key];
			if (typeof value === "string" && value) return value;
		}
		const results = record.results;
		if (Array.isArray(results)) {
			for (const entry of results) {
				const found = backgroundRunId(entry);
				if (found) return found;
			}
		}
		return undefined;
	}

	function persist(): void {
		pi.appendEntry<PersistedState>(STATE_TYPE, {
			version: 1,
			armed,
			campaign,
			judgeModel,
			judgeEnabled,
			...(tiers === DEFAULT_TIERS ? {} : { tiers }),
		});
	}

	/**
	 * Ask the judge about one prompt. Structural facts never reach it, so this only runs for
	 * dispatches that already passed phase one: a handful per campaign, not per tool call.
	 */
	async function judgePrompt(
		ctx: ExtensionContext,
		target: { prompt: string; agent?: string; declaredClass: 1 | 2 | 3 },
	): Promise<{ ok: true; verdict: PromptVerdict; fromCache: boolean } | { ok: false; error: string }> {
		const request = { prompt: target.prompt, agent: target.agent, declaredClass: target.declaredClass };
		const key = judgeCacheKey(request);
		const cached = verdictCache.get(key);
		if (cached) return { ok: true, verdict: cached, fromCache: true };

		const resolved = resolveJudgeModel(ctx);
		if (!resolved) {
			return { ok: false, error: `the judge model ${judgeModel} is not available; set another with /campaign judge <provider/model:effort>` };
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved.model);
		if (!auth.ok) return { ok: false, error: `no credentials are configured for ${judgeModel}` };

		const call: JudgeCall = async (systemPrompt, message) => {
			const userMessage: UserMessage = { role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() };
			// Only the simple API maps a generic reasoning level; the raw one takes
			// provider-specific fields, so a level passed there is silently dropped.
			const options = {
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: ctx.signal,
				maxTokens: JUDGE_MAX_TOKENS,
			};
			const response = resolved.effort
				? await completeSimple(resolved.model, { systemPrompt, messages: [userMessage] }, { ...options, reasoning: resolved.effort })
				: await complete(resolved.model, { systemPrompt, messages: [userMessage] }, options);
			const text = response.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			return { text, stopReason: response.stopReason };
		};

		const outcome = await judgeDispatch(call, request);
		if (!outcome.ok) return { ok: false, error: outcome.error };
		verdictCache.set(key, outcome.verdict);
		return { ok: true, verdict: outcome.verdict, fromCache: false };
	}

	/** `provider/model` with an optional `:effort` suffix, resolved against the live registry. */
	function resolveJudgeModel(ctx: ExtensionContext): { model: Model<any>; effort?: ThinkingLevel } | null {
		const colon = judgeModel.lastIndexOf(":");
		const slash = judgeModel.indexOf("/");
		if (slash <= 0) return null;
		const hasEffort = colon > slash;
		const spec = hasEffort ? judgeModel.slice(0, colon) : judgeModel;
		const effort = hasEffort ? judgeModel.slice(colon + 1) : undefined;
		const provider = spec.slice(0, spec.indexOf("/"));
		const id = spec.slice(spec.indexOf("/") + 1);
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) return null;
		// Clamp to what this model actually supports rather than sending a level it will reject.
		const clamped = effort ? (clampThinkingLevel(model, effort as ThinkingLevel) as ThinkingLevel) : undefined;
		return { model, effort: clamped === "off" ? undefined : clamped };
	}

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	}

	/** The tier table with whatever throughput history can be measured for each entry. */
	function renderModels(): string {
		const measured = readThroughput();
		const lines = ["Coordinator guard tiers. Position one is what the contract tells the coordinator to reach for; the rest are accepted fallbacks.", ""];
		for (const [axis, lists] of [
			["class", tiers.class],
			["review", tiers.review],
		] as const) {
			for (const [cls, entries] of Object.entries(lists)) {
				lines.push(`${axis} ${cls}`);
				entries.forEach((entry, index) => {
					const rate = rateFor(measured, entry);
					const speed = rate ? `${rate.tokensPerSecond.toFixed(1)} tok/s over ${rate.samples} samples` : "no measurement yet";
					lines.push(`  ${index === 0 ? "->" : "  "} ${entry.padEnd(42)} ${speed}`);
				});
			}
		}
		lines.push(
			"",
			tiers === DEFAULT_TIERS ? "These are the defaults." : "These include your overrides; /campaign models reset restores the defaults.",
			"Throughput is output tokens over wall clock from your own sessions, so it ranks rather than benchmarks: the gap also contains tool and queue time.",
			"",
			"Set:   /campaign models class <1|2|3> <provider/model:effort>[, ...]",
			"       /campaign models review <1|2> <provider/model:effort>[, ...]",
			"GPT:    /campaign models gpt       set every tier and the judge to its OpenAI calibrated default",
			"Claude: /campaign models claude    set every tier and the judge to its Claude calibrated default",
			"Auto:   /campaign models auto      reorder each class by measured throughput, leaving unmeasured entries in place",
			"Reset:  /campaign models reset",
		);
		return lines.join("\n");
	}

	function handleModels(argument: string): string {
		if (argument === "") return renderModels();

		if (argument === "reset") {
			tiers = DEFAULT_TIERS;
			persist();
			return `Tiers reset to the defaults.\n\n${renderTiers(tiers)}`;
		}

		if (["gpt", "openai", "openai-codex"].includes(argument.toLowerCase())) {
			tiers = GPT_DEFAULT_TIERS;
			judgeModel = DEFAULT_JUDGE_MODEL;
			persist();
			return `OpenAI GPT defaults selected for every implementation and review tier, and the judge is now ${judgeModel}. The current coordinator session model is unchanged: use /model to select it separately.\n\n${renderTiers(tiers)}`;
		}

		if (["claude", "anthropic", "claude-bridge"].includes(argument.toLowerCase())) {
			tiers = CLAUDE_DEFAULT_TIERS;
			judgeModel = CLAUDE_JUDGE_MODEL;
			persist();
			return `Claude defaults selected for every implementation and review tier, and the judge is now ${judgeModel}. The current coordinator session model is unchanged: use /model to select it separately.\n\n${renderTiers(tiers)}`;
		}

		if (argument === "auto") {
			const measured = readThroughput();
			const reordered = reorderByThroughput(tiers, measured);
			if (reordered.changed.length === 0) {
				return `No reordering: every class is already fastest-first, or has no measurement to go on.\n\n${renderTiers(tiers)}`;
			}
			tiers = reordered.tiers;
			persist();
			return `Reordered by measured throughput: ${reordered.changed.join(", ")}.\n\n${renderTiers(tiers)}`;
		}

		const match = /^(class|review)\s+([123])\s+(.+)$/i.exec(argument);
		if (!match) {
			return 'Usage: /campaign models [gpt | claude | class <1|2|3> <pins> | review <1|2> <pins> | auto | reset]. GPT or Claude selects all calibrated defaults for that provider, including the judge. Pins are comma separated, as provider/model:effort.';
		}
		const axis = match[1].toLowerCase() as "class" | "review";
		const cls = Number(match[2]);
		if (axis === "review" && cls > 2) return "The review axis has two classes: review 1 and review 2.";

		const parsed = parseTierEntries(match[3]);
		if (!parsed.ok) return `Not applied: ${parsed.error}`;

		const clash = findTierClash(tiers, axis, cls, parsed.entries);
		if (clash) {
			return `Not applied: ${clash} A pin in two classes makes the table ambiguous, and the class actually enforced would be whichever is found first.`;
		}

		tiers = withTierList(tiers, axis, cls, parsed.entries);
		persist();
		return `${axis} ${cls} is now ${parsed.entries.join(", ")}. Enforced from the next dispatch.\n\n${renderTiers(tiers)}`;
	}

	/** A guard notice in the transcript: shown now, and not sent to the model. */
	function notice(text: string): void {
		pi.appendEntry<{ text: string }>(NOTICE_TYPE, { text });
	}

	function showJudgeCard(
		judgements: Array<{ target: JudgeTarget; verdict: PromptVerdict }>,
		cacheFlags: boolean[],
		elapsedMs: number,
		decision: { allow: true } | { allow: false; code: string; reason: string },
	): void {
		const pin = parseModelPin(judgeModel);
		pi.appendEntry<JudgeCard>(JUDGE_ENTRY_TYPE, {
			model: pin?.id ?? judgeModel,
			effort: pin?.effort ?? "unpinned",
			elapsedMs,
			cached: cacheFlags.filter(Boolean).length,
			outcome: decision.allow ? { allowed: true } : { allowed: false, code: decision.code, reason: decision.reason },
			targets: judgements.map(({ target, verdict }, index) => ({
				routeKey: target.routeKey,
				...(target.agent === undefined ? {} : { agent: target.agent }),
				declaredClass: target.declaredClass,
				fromCache: cacheFlags[index] === true,
				verdict,
			})),
		});
	}

	function updateStatusLine(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!campaign) {
			ctx.ui.setStatus("coordinator-guard", armed ? ctx.ui.theme.fg("warning", "Guard armed, no campaign") : undefined);
			return;
		}
		const open = campaign.lanes.filter((lane) => lane.state !== "integrated").length;
		const label = `Campaign ${campaign.slug} ${campaign.slicesDone}/${campaign.slicesTotal}, ${open} open`;
		ctx.ui.setStatus("coordinator-guard", ctx.ui.theme.fg(campaign.status === "closed" ? "muted" : "accent", label));
	}

	function reconstruct(ctx: ExtensionContext): void {
		campaign = null;
		armed = false;
		judgeModel = DEFAULT_JUDGE_MODEL;
		judgeEnabled = true;
		tiers = DEFAULT_TIERS;
		verdictCache.clear();
		noProgressContinuations = 0;
		consecutiveErrors = 0;
		continuationQueued = false;
		if (continuationTimer) clearTimeout(continuationTimer);
		continuationTimer = null;
		laneByToolCall.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
			const data = entry.data as PersistedState | undefined;
			if (!data) continue;
			armed = data.armed === true;
			campaign = data.campaign ?? null;
			judgeModel = typeof data.judgeModel === "string" && data.judgeModel ? data.judgeModel : DEFAULT_JUDGE_MODEL;
			judgeEnabled = data.judgeEnabled !== false;
			tiers = isTierLists(data.tiers) ? data.tiers : DEFAULT_TIERS;
		}
		updateStatusLine(ctx);
	}

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	pi.on("session_shutdown", async () => {
		if (continuationTimer) clearTimeout(continuationTimer);
		continuationTimer = null;
	});

	pi.on("input", async (event) => {
		if (!armed && /\/skill:coordinator|\buse the coordinator\b/i.test(event.text ?? "")) {
			armed = true;
			persist();
		}
	});

	pi.on("before_agent_start", async (event) => {
		const contract = contractPrompt(campaign, armed, Date.now(), undefined, tiers);
		if (!contract) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${contract}` };
	});

	// The judge is the one part of the guard that spends a model call and reaches a
	// conclusion the transcript never showed. Collapsed it states model, effort, and the
	// verdict; expanded it shows every answer the verdict is made of, per dispatch.
	// The judge is the one part of the guard that spends a model call and reaches a
	// conclusion the transcript never showed. Collapsed it states model, effort, and the
	// verdict; expanded it shows every answer the verdict is made of, per dispatch. One Text
	// with newlines rather than a child per line: a child per line renders a blank between
	// each, which pi's own tool cards do not have.
	// Notices render the moment they are appended, and never reach the model. sendMessage
	// would do neither: it queues a session message, which is why command output arrived a
	// turn late, and it would spend context on text written for the user.
	pi.registerEntryRenderer<{ text: string }>(NOTICE_TYPE, (entry, _options, theme) => {
		const text = entry.data?.text;
		if (typeof text !== "string") return undefined;
		return new Text(theme.fg("muted", text));
	});

	pi.registerEntryRenderer<JudgeCard>(JUDGE_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const card = entry.data;
		if (!card || !Array.isArray(card.targets)) return undefined;

		const keys = card.targets.map((target) => target.routeKey).join(", ");
		const noun = card.targets.length === 1 ? "dispatch" : "dispatches";
		const dot = theme.fg("muted", "·");
		const lines = [
			`${theme.fg("toolTitle", "guard judge")} ${dot} ${theme.fg("accent", `${card.model}:${card.effort}`)} ${dot} ${card.targets.length} ${noun}: ${keys}`,
		];

		const verdict = card.outcome.allowed ? theme.fg("success", "passed") : theme.fg("error", `refused ${card.outcome.code}`);
		const cost = card.cached > 0 ? `${card.elapsedMs}ms, ${card.cached} from cache` : `${card.elapsedMs}ms`;
		const detail = card.outcome.allowed ? "" : ` ${dot} ${firstLine(card.outcome.reason)}`;
		lines.push(`  ${verdict} ${dot} ${theme.fg("dim", cost)}${detail}`);

		if (!expanded) {
			lines.push(theme.fg("dim", `  ${card.targets.length * 8} lines of verdict, press ctrl+o for full output`));
			return new Text(lines.join("\n"));
		}

		for (const target of card.targets) {
			const axis = target.agent === "campaign-reviewer" ? "review" : "class";
			const from = target.fromCache ? ", cached" : "";
			lines.push(`  ${theme.bold(target.routeKey)} ${theme.fg("dim", `${target.agent ?? "no role"}, declared ${axis} ${target.declaredClass}${from}`)}`);
			for (const [label, value] of verdictRows(target.verdict)) {
				lines.push(`    ${theme.fg("muted", label.padEnd(21))} ${value}`);
			}
		}
		return new Text(lines.join("\n"));
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (event.toolName === "read") {
				const path = String((event.input as { path?: unknown }).path ?? "");
				if (/coordinator\/(SKILL|dispatch|harness)\.md$/i.test(path) && !armed) {
					armed = true;
					persist();
					updateStatusLine(ctx);
					// Arming silently once meant a campaign could route for an hour before anyone saw
					// which models were enforceable.
					notice(`Coordinator guard armed.\n\n${contractPrompt(null, true, Date.now(), undefined, tiers)}`);
				}
				return;
			}

			if (campaign && event.toolName === "subagent" && roleShadowCache === null) {
				roleShadowCache = findRoleShadows(agentsDir, campaign.worktree);
			}
			if (campaign && event.toolName === "subagent" && roleShadowCache && roleShadowCache.length > 0) {
				notify(ctx, "Guard CG019: refused", "warning");
				return {
					block: true,
					reason: `[coordinator-guard CG019] The campaign role names are shadowed by higher-precedence agent files, so a dispatch would run someone else's prompt under the guard's name: ${roleShadowCache.join(", ")}. Ask the user to delete or rename ${roleShadowCache.length > 1 ? "these files" : "this file"}; the guard cannot tell which definition pi would resolve.`,
				};
			}

			// pi-subagents 0.43.0 removed direct execution, so a top-level agent or task without
			// a workflowScript is a shape the runtime will reject after the guard has already
			// recorded the lane, leaving a phantom lane holding writer capacity. Refused here
			// because this is a pi runtime fact, not a policy rule.
			const raw = event.input as Record<string, unknown>;
			if (
				campaign &&
				event.toolName === "subagent" &&
				raw.action === undefined &&
				typeof raw.workflowScript !== "string" &&
				(raw.agent !== undefined || raw.task !== undefined || raw.step !== undefined)
			) {
				notify(ctx, "Guard CG002: refused", "warning");
				return {
					block: true,
					reason:
						'[coordinator-guard CG002] Direct execution no longer exists in this pi-subagents version: a top-level agent or task is rejected by the runtime after the lane is already recorded. Dispatch as a single-child script instead, with async stated at top level: workflowScript: "return runs.run(\'<key>\', { agent: \'campaign-worker\', model: \'<provider/model:effort>\', task: `ROUTE: ...` })".',
				};
			}

			const request = {
				tool: event.toolName,
				input: raw,
				now: Date.now(),
				armed,
				campaign,
				tiers,
			};

			// Phase one is free: a malformed dispatch is refused without spending a model call.
			const structure = evaluateStructure(request);
			if (!structure.allow) {
				notify(ctx, `Guard ${structure.code}: refused`, "warning");
				return { block: true, reason: `[coordinator-guard ${structure.code}] ${structure.reason}` };
			}
			if (structure.judge.length === 0) {
				// Management actions end here, and the correction counter lives on this path.
				if (event.toolName === "subagent") recordCorrection(event.input as Record<string, unknown>);
				return;
			}

			// With the judge off, the prompt rules are not enforced at all: the user asked for
			// that, and inventing a verdict would either refuse everything or fake a pass.
			if (!judgeEnabled) {
				// Structural rules still apply, and the writer cap is one of them: with nothing
				// reading the prompts, every launch counts as a writer, which is the safe reading.
				if (campaign) {
					const cap = checkWriterCap(campaign, structure.judge.length);
					if (!cap.allow) {
						notify(ctx, `Guard ${cap.code}: refused`, "warning");
						return { block: true, reason: `[coordinator-guard ${cap.code}] ${cap.reason}` };
					}
				}
				if (event.toolName === "subagent") {
					recordLaunchUnjudged(event.toolCallId, event.input as Record<string, unknown>, ctx, structure.judge);
				}
				return;
			}

			// Phase two reads the prompts. An unread prompt is an unchecked one, so a judge that
			// cannot answer refuses the dispatch rather than waving it through.
			const judgements: Array<{ target: (typeof structure.judge)[number]; verdict: PromptVerdict }> = [];
			const cacheFlags: boolean[] = [];
			const judgeStartedAt = Date.now();
			for (const target of structure.judge) {
				const outcome = await judgePrompt(ctx, target);
				if (!outcome.ok) {
					notify(ctx, `Guard: the judge could not read this dispatch (${outcome.error})`, "error");
					return {
						block: true,
						reason: `[coordinator-guard CG018] This dispatch could not be checked, because ${outcome.error}. The guard refuses what it cannot read. Retry, pick another judge model with /campaign judge <provider/model:effort>, or have the user turn the judge off with /campaign judge off.`,
					};
				}
				judgements.push({ target, verdict: outcome.verdict });
				cacheFlags.push(outcome.fromCache);
			}
			const judgeElapsedMs = Date.now() - judgeStartedAt;

			const judged = evaluateVerdicts(request, judgements);
			showJudgeCard(judgements, cacheFlags, judgeElapsedMs, judged);
			if (!judged.allow) {
				notify(ctx, `Guard ${judged.code}: refused`, "warning");
				return { block: true, reason: `[coordinator-guard ${judged.code}] ${judged.reason}` };
			}

			if (event.toolName === "subagent") {
				recordLaunch(event.toolCallId, event.input as Record<string, unknown>, ctx, judgements);
			}
		} catch (error) {
			notify(ctx, `coordinator-guard internal error, allowing the call: ${String(error)}`, "error");
		}
	});

	/** The correction cap is enforced in policy, so the count has to be kept even when the
	 * call never reaches recordLaunch. */
	function recordCorrection(input: Record<string, unknown>): void {
		if (!campaign || campaign.status === "closed") return;
		if (!isManagementAction(input) || !CORRECTION_ACTIONS.has(String(input.action))) return;
		const runId =
			typeof input.id === "string" ? input.id : typeof input.runId === "string" ? input.runId : typeof input.dir === "string" ? input.dir : "";
		if (!runId) return;
		campaign.steers[runId] = (campaign.steers[runId] ?? 0) + 1;
		persist();
	}

	/** With the judge off nothing read the prompt, so a lane is recorded as a writer: the
	 * conservative reading, because a writer is what the caps and the review gate exist for. */
	function recordLaunchUnjudged(
		toolCallId: string,
		input: Record<string, unknown>,
		ctx: ExtensionContext,
		targets: JudgeTarget[],
	): void {
		recordLaunch(
			toolCallId,
			input,
			ctx,
			targets.map((target) => ({
				target,
				verdict: {
					kind: "implement" as const,
					worktree: null,
					expectedHead: null,
					stopsOnHeadMismatch: true,
					forbidsPush: true,
					coordinatorGitWork: "none" as const,
					unrenderedPlaceholders: [],
					classJustification: "substantive" as const,
				},
			})),
		);
	}

	function recordLaunch(
		toolCallId: string,
		input: Record<string, unknown>,
		ctx: ExtensionContext,
		judgements: Array<{ target: JudgeTarget; verdict: PromptVerdict }>,
	): void {
		// A closed campaign enforces nothing, so it must not accumulate lanes a later resume
		// would treat as its own.
		if (!campaign || campaign.status === "closed") return;
		if (isManagementAction(input)) return;
		if (judgements.length === 0) return;

		// The lane records the kind the guard actually admitted, so accounting and admission
		// can never disagree about what was launched.
		for (const { target, verdict } of judgements) {
			campaign.lanes.push({
				key: target.routeKey,
				kind: verdict.kind,
				model: target.model,
				startedAt: Date.now(),
				state: "running",
			});
			const route = parseRouteHeader(target.prompt);
			if (route) campaign.routes.push(route);
		}
		// The launch had to declare its mode, so the lane is tracked from that declaration rather
		// than from a default the guard cannot see. clarify keeps a run in the foreground too.
		const foreground = input.async === false || input.clarify === true;
		laneByToolCall.set(toolCallId, { keys: judgements.map((entry) => entry.target.routeKey), foreground });
		recordProgress();
		persist();
		updateStatusLine(ctx);
	}

	pi.on("tool_result", async (event, ctx) => {
		const tracked = laneByToolCall.get(event.toolCallId);
		if (!tracked || !campaign) return;
		laneByToolCall.delete(event.toolCallId);
		const runId = backgroundRunId(event.details);
		let changed = false;
		for (const key of tracked.keys) {
			const lane = campaign.lanes.find((candidate) => candidate.key === key && candidate.state === "running");
			if (!lane) continue;
			if (event.isError && !tracked.foreground) {
				// A background launch reports before the child runs, so an error here means it never
				// started: the lane must not hold capacity or drive continuations.
				campaign.lanes = campaign.lanes.filter((candidate) => candidate !== lane);
				notify(ctx, `coordinator-guard: lane ${key} failed to launch and was removed`, "warning");
				changed = true;
			} else if (tracked.foreground) {
				// A foreground failure may still have written to the tree, so a writer lane stays
				// open for adjudication instead of vanishing. Read-only lanes are done when they report.
				lane.state = lane.kind === "implement" ? "returned" : "integrated";
				if (event.isError) notify(ctx, `coordinator-guard: lane ${key} failed; its tree still needs adjudication`, "warning");
				changed = true;
			} else if (runId && !lane.runId) {
				lane.runId = runId;
				changed = true;
			}
		}
		if (!changed) return;
		recordProgress();
		persist();
		updateStatusLine(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!campaign || event.message.role !== "assistant") return;
		const content = Array.isArray(event.message.content) ? event.message.content : [];
		const assistantText = content
			.filter((part: { type?: string }) => part.type === "text")
			.map((part: { text?: string }) => part.text ?? "")
			.join("\n");
		if (!/^[ \t>*-]*CAMPAIGN\b/im.test(assistantText)) return;
		const block = readStatusBlock(assistantText);
		if (!block.ok) {
			const problem = `it is missing required field${block.missing.length > 1 ? "s" : ""} ${block.missing.join(", ")}.`;
			campaign.lastStatusProblem = problem;
			persist();
			notify(ctx, `Status block missing ${block.missing.join(", ")}, not counted as fresh`, "warning");
			notice(`Coordinator guard: status block not counted, because ${problem}`);
			return;
		}
		// A block that contradicts the ledger does not refresh it. The next launch then fails
		// CG008, which is the existing path back: the alternative, believing the prose, would
		// let narration write the state that gates review.
		const disagreement = statusBlockDisagreement(block, campaign);
		if (disagreement) {
			campaign.lastStatusProblem = disagreement;
			persist();
			notify(ctx, `Status block not counted as fresh: ${disagreement}`, "warning");
			notice(`Coordinator guard: status block not counted, because ${disagreement}`);
			return;
		}
		campaign.lastStatusProblem = null;
		campaign.lastStatusAt = Date.now();
		persist();
		updateStatusLine(ctx);
	});

	pi.on("agent_start", async () => {
		continuationQueued = false;
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!campaign || campaign.status === "closed") return;
		if (continuationQueued || continuationTimer || ctx.hasPendingMessages()) return;
		if (noProgressContinuations >= MAX_NO_PROGRESS_CONTINUATIONS) {
			notify(ctx, `coordinator-guard: ${noProgressContinuations} continuations with no lane progress, paused. Use /campaign resume.`, "warning");
			return;
		}
		const last = [...event.messages].reverse().find((message) => message.role === "assistant") as
			| { stopReason?: string }
			| undefined;
		consecutiveErrors = last?.stopReason === "error" ? consecutiveErrors + 1 : 0;
		const carry = continuationDecision(campaign, { stopReason: last?.stopReason, consecutiveErrors });
		if (!carry.proceed) {
			if (last?.stopReason === "error") {
				notify(ctx, `coordinator-guard: campaign not continued, ${carry.reason}. Use /campaign resume.`, "warning");
			}
			return;
		}

		const wait = Math.max(0, CONTINUATION_INTERVAL_MS - (Date.now() - lastContinuationAt));
		continuationTimer = setTimeout(() => {
			continuationTimer = null;
			// This fires long after the turn that scheduled it, and the session may have been
			// replaced, reloaded, or ended in between. A captured ctx throws once that happens, so
			// a missed continuation has to stay a missed continuation rather than a crashed pi.
			try {
				if (!campaign || campaign.status === "closed") return;
				if (!continuationDecision(campaign, { consecutiveErrors: 0 }).proceed) return;
				if (continuationQueued || ctx.hasPendingMessages() || !ctx.isIdle()) return;
				continuationQueued = true;
				noProgressContinuations += 1;
				lastContinuationAt = Date.now();
				pi.sendMessage({ customType: CONTINUATION_TYPE, content: continuationPrompt(campaign), display: false }, { triggerTurn: true });
			} catch {
				continuationQueued = false;
			}
		}, wait);
		continuationTimer.unref?.();
	});

	// Sessions started before notices became entries still carry them as messages, and those
	// would otherwise be replayed into context on resume.
	pi.on("context", async (event) => ({
		messages: event.messages.filter((message) => {
			const custom = message as { customType?: string };
			return custom.customType !== NOTICE_TYPE;
		}),
	}));

	pi.registerTool({
		name: "coordinator_campaign",
		label: "Coordinator Campaign",
		description:
			"Register and drive the guarded campaign lifecycle. Call action \"start\" before the first dispatch of a coordinator campaign; dispatches are blocked until you do. Use \"set-slices\" as slices land, \"open-review\" once every slice is done, and \"close\" when the campaign is over.",
		promptSnippet: "Register or update the guarded coordinator campaign",
		parameters: StartParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const now = Date.now();
			switch (params.action) {
				case "start": {
					if (!params.slug || !params.worktree || params.slices_total === undefined || !params.authorized) {
						throw new Error("start requires slug, worktree, slices_total, and authorized");
					}
					if (campaign && campaign.status !== "closed") {
						throw new Error(
							`campaign ${campaign.slug} is still ${campaign.status} with lanes: ${laneSummary(campaign)}. Starting over would discard its lanes, routes, and steer counts while its agents are still live. Close it first with action "close".`,
						);
					}
					if (!Number.isInteger(params.slices_total) || params.slices_total < 1) {
						throw new Error("slices_total must be a positive integer");
					}
					campaign = newCampaign({
						slug: params.slug,
						worktree: params.worktree,
						planPath: params.plan_path ?? null,
						slicesTotal: params.slices_total,
						authorized: params.authorized,
						startedAt: now,
					});
					armed = true;
					recordProgress();
					break;
				}
				case "set-slices": {
					if (!campaign) throw new Error("no campaign is registered");
					const total = params.slices_total ?? campaign.slicesTotal;
					const done = params.slices_done ?? campaign.slicesDone;
					if (!Number.isInteger(total) || total < 1) throw new Error("slices_total must be a positive integer");
					if (!Number.isInteger(done) || done < 0) throw new Error("slices_done must be a non-negative integer");
					if (done > total) throw new Error(`slices_done ${done} cannot exceed slices_total ${total}`);
					campaign.slicesTotal = total;
					campaign.slicesDone = done;
					// Slices reopening means the review phase was opened too early; reviewers wait again.
					if (campaign.status === "review" && done < total) campaign.status = "active";
					break;
				}
				case "open-review": {
					if (!campaign) throw new Error("no campaign is registered");
					const verdict = openReview(campaign);
					if (!verdict.ok) throw new Error(verdict.error);
					campaign.status = "review";
					break;
				}
				case "close": {
					if (!campaign) throw new Error("no campaign is registered");
					// Closing turns every rule off, so it is not a way out of an unfinished campaign.
					// The user's /campaign close stays available as the deliberate override.
					const openLanes = campaign.lanes.filter((lane) => lane.state !== "integrated");
					if (openLanes.length > 0) {
						throw new Error(`these lanes are still open: ${laneSummary(campaign)}. Close them with coordinator_lane before closing the campaign.`);
					}
					if (campaign.slicesDone < campaign.slicesTotal) {
						throw new Error(
							`${campaign.slicesDone} of ${campaign.slicesTotal} slices are done, so the campaign is not finished. Closing would turn every rule off. Keep working, or ask the user to end it with /campaign close.`,
						);
					}
					campaign.status = "closed";
					armed = false;
					break;
				}
				case "show":
					break;
			}
			persist();
			updateStatusLine(ctx);
			const view = campaign ? { ...campaign, contract: contractPrompt(campaign, armed, now, undefined, tiers) } : null;
			return {
				content: [{ type: "text", text: JSON.stringify(view, null, 2) }],
				details: view,
			};
		},
	});

	pi.registerTool({
		name: "coordinator_lane",
		label: "Coordinator Lane",
		description:
			"Record what happened to a dispatched lane. \"returned\" when a writer's work came back, \"integrated\" once you have merged that work into the campaign branch and run the gates yourself, \"done\" to close a read-only review or investigation lane that has reported, \"dead\" when the run died. Integrating a writer lane also records the slice through the required \"slice\" field, so the count cannot drift from the work. Open lanes count against the writer cap until they are integrated.",
		promptSnippet: "Record a dispatched lane as returned, integrated, or dead",
		parameters: LaneParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!campaign) throw new Error("no campaign is registered");
			// A slice key is reused across retries, so target the live lane rather than a finished
			// one with the same name, which would leave the live one running forever.
			const open = campaign.lanes.filter((candidate) => candidate.key === params.key && candidate.state !== "integrated");
			const lane = open[open.length - 1];
			if (!lane) throw new Error(`no open lane named ${params.key}; open lanes: ${laneSummary(campaign)}`);
			if (params.action === "done" && lane.kind === "implement") {
				throw new Error(
					`lane ${params.key} is a writer, so "done" would free its capacity without recording an integration. Integrate its work into the campaign branch, run the gates yourself, then use "integrated".`,
				);
			}
			// The slice count used to live behind a second tool nothing forced anyone to call, so
			// it froze while the work continued. Integration is the moment the slice is known.
			if (params.action === "integrated" && lane.kind === "implement" && params.slice === undefined) {
				throw new Error(
					`integrating writer lane ${params.key} also records the slice: pass slice "done" when this finishes a slice, "retry" when it re-ran a slice already counted, or "partial" when the slice needs more work. The count is ${campaign.slicesDone} of ${campaign.slicesTotal}, and review opens on it.`,
				);
			}
			if (params.action === "dead") {
				campaign.lanes = campaign.lanes.filter((candidate) => candidate !== lane);
			} else {
				lane.state = params.action === "done" ? "integrated" : params.action;
				if (params.note) lane.note = params.note;
			}
			if (params.action === "integrated" && lane.kind === "implement" && params.slice) {
				campaign = { ...campaign, ...recordIntegration(campaign, params.slice) };
			}
			recordProgress();
			persist();
			updateStatusLine(ctx);
			return {
				content: [
					{
						type: "text",
						text: `lane ${params.key} -> ${params.action}. Slices: ${campaign.slicesDone} of ${campaign.slicesTotal}. Open: ${laneSummary(campaign)}`,
					},
				],
				details: { lanes: campaign.lanes },
			};
		},
	});

	pi.registerCommand("campaign", {
		description: "Inspect or control the guarded coordinator campaign",
		getArgumentCompletions: (prefix: string) => {
			const trimmed = prefix.trimStart();
			const [head, ...rest] = trimmed.split(/\s+/);
			const suggest = (items: Array<{ value: string; label: string; description?: string }>) => {
				const matched = items.filter((item) => item.value.startsWith(trimmed));
				return matched.length > 0 ? matched : null;
			};

			if (head === "judge" && rest.length > 0) {
				return suggest([
					{ value: "judge on", label: "judge on", description: "enforce the rules that need a prompt read" },
					{ value: "judge off", label: "judge off", description: "structural rules only" },
					{ value: `judge ${DEFAULT_JUDGE_MODEL}`, label: `judge ${DEFAULT_JUDGE_MODEL}`, description: "set the judge model" },
				]);
			}

			if (head === "models" && rest.length > 0) {
				const tierOptions = [
					{ value: "models gpt", label: "models gpt", description: "OpenAI defaults for all tiers and the judge" },
					{ value: "models claude", label: "models claude", description: "Claude defaults for all tiers and the judge" },
					{ value: "models auto", label: "models auto", description: "reorder each class fastest-measured first" },
					{ value: "models reset", label: "models reset", description: "back to the defaults" },
				];
				for (const cls of [1, 2, 3] as const) {
					tierOptions.push({
						value: `models class ${cls} ${tiers.class[cls][0]}`,
						label: `models class ${cls}`,
						description: `currently ${tiers.class[cls].join(", ")}`,
					});
				}
				for (const cls of [1, 2] as const) {
					tierOptions.push({
						value: `models review ${cls} ${tiers.review[cls][0]}`,
						label: `models review ${cls}`,
						description: `currently ${tiers.review[cls].join(", ")}`,
					});
				}
				return suggest(tierOptions);
			}

			return suggest([
				{ value: "", label: "campaign", description: "show the contract, or the armed state" },
				{ value: "models", label: "models", description: "show or set the tier lists" },
				{ value: "judge", label: "judge", description: "show or set the prompt judge" },
				{ value: "arm", label: "arm", description: "turn enforcement on" },
				{ value: "disarm", label: "disarm", description: "turn enforcement off, once no campaign is active" },
				{ value: "close", label: "close", description: "end the campaign and disarm" },
				{ value: "resume", label: "resume", description: "reactivate a closed campaign" },
			]);
		},
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			const show = (text: string) => notice(text);
			switch (command) {
				case "":
					show(
						campaign
							? contractPrompt(campaign, armed, Date.now(), undefined, tiers)
							: armed
								? contractPrompt(null, true, Date.now(), undefined, tiers)
								: "Coordinator guard inert, no campaign registered.",
					);
					break;
				case "arm":
				case "disarm":
					if (command === "disarm" && campaign && campaign.status !== "closed") {
						show(`Campaign ${campaign.slug} is still ${campaign.status}, so disarming would not turn enforcement off. Use /campaign close to end it.`);
						break;
					}
					armed = command === "arm";
					persist();
					show(armed ? `Coordinator guard armed.\n\n${contractPrompt(null, true, Date.now(), undefined, tiers)}` : "Coordinator guard disarmed.");
					break;
				case "close":
					if (campaign) campaign.status = "closed";
					armed = false;
					persist();
					show("Campaign closed and guard disarmed. Enforcement is off until the next campaign.");
					break;
				case "resume":
					if (campaign) campaign.status = "active";
					armed = true;
					noProgressContinuations = 0;
					consecutiveErrors = 0;
					lastContinuationAt = 0;
					persist();
					show("Campaign active.");
					break;
				default: {
					if (command === "models" || command.startsWith("models ")) {
						show(handleModels(args.trim().slice("models".length).trim()));
						break;
					}
					if (command === "judge" || command.startsWith("judge ")) {
						const argument = command.slice("judge".length).trim();
						if (!argument) {
							show(`Judge ${judgeEnabled ? `on, using ${judgeModel}` : "off: prompt rules are not enforced"}.`);
						} else if (argument === "off") {
							judgeEnabled = false;
							persist();
							show("Judge off. Structural rules still apply; nothing that depends on reading a prompt does.");
						} else if (argument === "on") {
							judgeEnabled = true;
							persist();
							show(`Judge on, using ${judgeModel}.`);
						} else if (argument.includes("/")) {
							judgeModel = argument;
							judgeEnabled = true;
							verdictCache.clear();
							persist();
							show(`Judge model set to ${judgeModel}.`);
						} else {
							show("Usage: /campaign judge [on|off|<provider/model:effort>]");
						}
						break;
					}
					show("Usage: /campaign [arm|disarm|close|resume|judge|models]");
				}
			}
			updateStatusLine(ctx);
		},
	});
}
