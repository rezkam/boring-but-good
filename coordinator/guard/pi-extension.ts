/**
 * Coordinator guard, pi harness wiring.
 *
 * The coordinator skill is prose, and prose decays: in a 19 hour campaign the rules were
 * quoted correctly in hour one and gone by hour three, for roughly seventy dispatches.
 * This extension turns the mechanical half of that skill into refusals at the tool
 * boundary, restates the contract every turn, and refuses to let the session go quiet
 * while agents are in flight.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	continuationPrompt,
	contractPrompt,
	evaluate,
	isManagementAction,
	laneKindFor,
	laneSummary,
	newCampaign,
	openReview,
	parseRouteHeader,
	parseScriptChildren,
	readStatusBlock,
	type Campaign,
	type Lane,
} from "./policy.ts";

const STATE_TYPE = "coordinator-guard";
const NOTICE_TYPE = "coordinator-guard-notice";
const CONTINUATION_TYPE = "coordinator-guard-continuation";

/** A continuation costs a turn, so it is rate limited to the status cadence rather than fired per idle turn. */
const CONTINUATION_INTERVAL_MS = 5 * 60_000;
/** After this many continuations with no lane changing state, the campaign is stuck and the user decides. */
const MAX_NO_PROGRESS_CONTINUATIONS = 10;

interface PersistedState {
	version: 1;
	armed: boolean;
	campaign: Campaign | null;
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
	let campaign: Campaign | null = null;
	let armed = false;
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
		pi.appendEntry<PersistedState>(STATE_TYPE, { version: 1, armed, campaign });
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
		}
		updateStatusLine(ctx);
	}

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

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

			const decision = evaluate({
				tool: event.toolName,
				input: event.input as Record<string, unknown>,
				now: Date.now(),
				armed,
				campaign,
			});

			if (!decision.allow) {
				notify(ctx, `Guard ${decision.code}: dispatch refused`, "warning");
				return { block: true, reason: `[coordinator-guard ${decision.code}] ${decision.reason}` };
			}

			if (event.toolName === "subagent") recordLaunch(event.toolCallId, event.input as Record<string, unknown>, ctx);
		} catch (error) {
			notify(ctx, `coordinator-guard internal error, allowing the call: ${String(error)}`, "error");
		}
	});

	function recordLaunch(toolCallId: string, input: Record<string, unknown>, ctx: ExtensionContext): void {
		// A closed campaign enforces nothing, so it must not accumulate lanes a later resume
		// would treat as its own.
		if (!campaign || campaign.status === "closed") return;
		// A scheduling action creates a run, so it becomes a lane like any other launch. Only a
		// genuine management action returns here.
		if (isManagementAction(input)) {
			if (input.action === "steer") {
				const runId = typeof input.id === "string" ? input.id : typeof input.runId === "string" ? input.runId : "";
				if (runId) {
					campaign.steers[runId] = (campaign.steers[runId] ?? 0) + 1;
					persist();
				}
			}
			return;
		}
		const script = typeof input.workflowScript === "string" ? input.workflowScript : "";
		const task = typeof input.task === "string" ? input.task : script;
		const agent = typeof input.agent === "string" ? input.agent : undefined;
		// Each child is classified from its own prompt and its own agent, the same pair admission
		// judged, so a lane is never recorded as a kind the guard did not actually allow.
		const launches = script
			? parseScriptChildren(script).children.map((child) => ({ prompt: child.task, agent: child.agent }))
			: [{ prompt: task, agent }];
		const lanes: Lane[] = [];
		for (const launch of launches) {
			const route = parseRouteHeader(launch.prompt);
			if (!route) continue;
			lanes.push({
				key: route.key,
				kind: laneKindFor(launch.agent, launch.prompt),
				model: route.model,
				startedAt: Date.now(),
				state: "running",
			});
			campaign.routes.push(route);
		}
		if (lanes.length === 0) return;
		const routes = lanes;
		campaign.lanes.push(...lanes);
		// Dispatches run in the background unless async is explicitly false, so only a declared
		// foreground run finishes when its tool result arrives. Background lanes are closed by
		// the coordinator through coordinator_lane, which is what the continuation asks for. Both
		// are tracked, because a launch that errors immediately must not leave a phantom lane.
		// The launch had to declare its mode, so the lane is tracked from that declaration rather
		// than from a default the guard cannot see. clarify keeps a run in the foreground too.
		const foreground = input.async === false || input.clarify === true;
		laneByToolCall.set(toolCallId, { keys: routes.map((lane) => lane.key), foreground });
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
			if (!campaign || campaign.status === "closed") return;
			if (campaign.lanes.every((lane) => lane.state === "integrated")) return;
			if (continuationQueued || ctx.hasPendingMessages() || !ctx.isIdle()) return;
			continuationQueued = true;
			noProgressContinuations += 1;
			lastContinuationAt = Date.now();
			pi.sendMessage({ customType: CONTINUATION_TYPE, content: continuationPrompt(campaign), display: false }, { triggerTurn: true });
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
				default:
					show("Usage: /campaign [arm|disarm|close|resume]");
			}
			updateStatusLine(ctx);
		},
	});
}
