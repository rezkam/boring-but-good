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
import { Type } from "typebox";
import { delimiter as pathDelimiter } from "node:path";
import { fileURLToPath } from "node:url";

import { judgeCacheKey, judgeDispatch, type JudgeCall, type PromptVerdict } from "./judge.ts";

import {
	continuationPrompt,
	contractPrompt,
	checkWriterCap,
	evaluateStructure,
	evaluateVerdicts,
	isManagementAction,
	laneSummary,
	newCampaign,
	openReview,
	parseRouteHeader,
	readStatusBlock,
	type Campaign,
	type JudgeTarget,
} from "./policy.ts";

const STATE_TYPE = "coordinator-guard";
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
const JUDGE_MAX_TOKENS = 700;

/** Mirrors the policy's correction actions, for counting what the guard already allowed. */
const CORRECTION_ACTIONS = new Set(["steer", "resume"]);

interface PersistedState {
	version: 1;
	armed: boolean;
	campaign: Campaign | null;
	judgeModel: string;
	judgeEnabled: boolean;
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
	note: Type.Optional(Type.String()),
});

export default function coordinatorGuard(pi: ExtensionAPI) {
	// The campaign roles live beside the guard and are registered with pi-subagents through
	// its extra-dirs env, which it reads at dispatch time. This is what lets the guard own
	// what a dispatched agent is told, rather than the builtin role prose.
	const agentsDir = fileURLToPath(new URL("./agents/", import.meta.url)).replace(/\/$/, "");
	const registered = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS?.split(pathDelimiter).filter(Boolean) ?? [];
	if (!registered.includes(agentsDir)) {
		process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = [...registered, agentsDir].join(pathDelimiter);
	}

	let campaign: Campaign | null = null;
	let armed = false;
	let judgeModel = DEFAULT_JUDGE_MODEL;
	let judgeEnabled = true;
	const verdictCache = new Map<string, PromptVerdict>();
	let noProgressContinuations = 0;
	let lastContinuationAt = 0;
	let continuationQueued = false;
	let continuationTimer: ReturnType<typeof setTimeout> | null = null;
	const laneByToolCall = new Map<string, { keys: string[]; foreground: boolean }>();

	function recordProgress(): void {
		noProgressContinuations = 0;
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
		pi.appendEntry<PersistedState>(STATE_TYPE, { version: 1, armed, campaign, judgeModel, judgeEnabled });
	}

	/**
	 * Ask the judge about one prompt. Structural facts never reach it, so this only runs for
	 * dispatches that already passed phase one: a handful per campaign, not per tool call.
	 */
	async function judgePrompt(
		ctx: ExtensionContext,
		target: { prompt: string; agent?: string; declaredClass: 1 | 2 | 3 },
	): Promise<{ ok: true; verdict: PromptVerdict } | { ok: false; error: string }> {
		const request = { prompt: target.prompt, agent: target.agent, declaredClass: target.declaredClass };
		const key = judgeCacheKey(request);
		const cached = verdictCache.get(key);
		if (cached) return { ok: true, verdict: cached };

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
		return { ok: true, verdict: outcome.verdict };
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
		verdictCache.clear();
		noProgressContinuations = 0;
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
		const contract = contractPrompt(campaign, armed, Date.now());
		if (!contract) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${contract}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (event.toolName === "read") {
				const path = String((event.input as { path?: unknown }).path ?? "");
				if (/coordinator\/(SKILL|dispatch|harness)\.md$/i.test(path) && !armed) {
					armed = true;
					persist();
					updateStatusLine(ctx);
				}
				return;
			}

			const request = {
				tool: event.toolName,
				input: event.input as Record<string, unknown>,
				now: Date.now(),
				armed,
				campaign,
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
			}

			const judged = evaluateVerdicts(request, judgements);
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
			notify(ctx, `Status block missing ${block.missing.join(", ")}, not counted as fresh`, "warning");
			return;
		}
		campaign.lastStatusAt = Date.now();
		persist();
		updateStatusLine(ctx);
	});

	pi.on("agent_start", async () => {
		continuationQueued = false;
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!campaign || campaign.status === "closed") return;
		const open = campaign.lanes.filter((lane) => lane.state !== "integrated");
		if (open.length === 0) return;
		if (continuationQueued || continuationTimer || ctx.hasPendingMessages()) return;
		if (noProgressContinuations >= MAX_NO_PROGRESS_CONTINUATIONS) {
			notify(ctx, `coordinator-guard: ${noProgressContinuations} continuations with no lane progress, paused. Use /campaign resume.`, "warning");
			return;
		}
		const last = [...event.messages].reverse().find((message) => message.role === "assistant") as
			| { stopReason?: string }
			| undefined;
		if (last?.stopReason === "aborted" || last?.stopReason === "error") return;

		const wait = Math.max(0, CONTINUATION_INTERVAL_MS - (Date.now() - lastContinuationAt));
		continuationTimer = setTimeout(() => {
			continuationTimer = null;
			// This fires long after the turn that scheduled it, and the session may have been
			// replaced, reloaded, or ended in between. A captured ctx throws once that happens, so
			// a missed continuation has to stay a missed continuation rather than a crashed pi.
			try {
				if (!campaign || campaign.status === "closed") return;
				if (campaign.lanes.every((lane) => lane.state === "integrated")) return;
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
			const view = campaign ? { ...campaign, contract: contractPrompt(campaign, armed, now) } : null;
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
			"Record what happened to a dispatched lane. \"returned\" when a writer's work came back, \"integrated\" once you have merged that work into the campaign branch and run the gates yourself, \"done\" to close a read-only review or investigation lane that has reported, \"dead\" when the run died. Open lanes count against the writer cap until they are integrated.",
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
			if (params.action === "dead") {
				campaign.lanes = campaign.lanes.filter((candidate) => candidate !== lane);
			} else {
				lane.state = params.action === "done" ? "integrated" : params.action;
				if (params.note) lane.note = params.note;
			}
			recordProgress();
			persist();
			updateStatusLine(ctx);
			return {
				content: [{ type: "text", text: `lane ${params.key} -> ${params.action}. Open: ${laneSummary(campaign)}` }],
				details: { lanes: campaign.lanes },
			};
		},
	});

	pi.registerCommand("campaign", {
		description: "Inspect or control the guarded coordinator campaign",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			const show = (text: string) => pi.sendMessage({ customType: NOTICE_TYPE, content: text, display: true }, { triggerTurn: false });
			switch (command) {
				case "":
					show(campaign ? contractPrompt(campaign, armed, Date.now()) : `Coordinator guard ${armed ? "armed" : "inert"}, no campaign registered.`);
					break;
				case "arm":
				case "disarm":
					if (command === "disarm" && campaign && campaign.status !== "closed") {
						show(`Campaign ${campaign.slug} is still ${campaign.status}, so disarming would not turn enforcement off. Use /campaign close to end it.`);
						break;
					}
					armed = command === "arm";
					persist();
					show(`Coordinator guard ${armed ? "armed" : "disarmed"}.`);
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
					lastContinuationAt = 0;
					persist();
					show("Campaign active.");
					break;
				default: {
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
					show("Usage: /campaign [arm|disarm|close|resume|judge]");
				}
			}
			updateStatusLine(ctx);
		},
	});
}
