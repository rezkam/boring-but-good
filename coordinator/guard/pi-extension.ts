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
	laneKindFor,
	laneSummary,
	newCampaign,
	openReview,
	parseRouteHeader,
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
	const laneByToolCall = new Map<string, string>();

	function recordProgress(): void {
		noProgressContinuations = 0;
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
		if (!campaign) return;
		if (typeof input.action === "string" && input.action) {
			if (input.action === "steer") {
				const runId = typeof input.id === "string" ? input.id : typeof input.runId === "string" ? input.runId : "";
				if (runId) {
					campaign.steers[runId] = (campaign.steers[runId] ?? 0) + 1;
					persist();
				}
			}
			return;
		}
		const task = typeof input.task === "string" ? input.task : typeof input.workflowScript === "string" ? input.workflowScript : "";
		const route = parseRouteHeader(task);
		if (!route) return;
		const lane: Lane = {
			key: route.key,
			kind: laneKindFor(typeof input.agent === "string" ? input.agent : undefined, task),
			model: route.model,
			startedAt: Date.now(),
			state: "running",
		};
		campaign.lanes = campaign.lanes.filter((existing) => existing.key !== route.key || existing.state === "integrated");
		campaign.lanes.push(lane);
		campaign.routes.push(route);
		// Dispatches run in the background unless async is explicitly false, so only a declared
		// foreground run finishes when its tool result arrives. Background lanes are closed by
		// the coordinator through coordinator_lane, which is what the continuation asks for.
		if (input.async === false) laneByToolCall.set(toolCallId, route.key);
		recordProgress();
		persist();
		updateStatusLine(ctx);
	}

	pi.on("tool_result", async (event, ctx) => {
		const key = laneByToolCall.get(event.toolCallId);
		if (!key || !campaign) return;
		laneByToolCall.delete(event.toolCallId);
		const lane = campaign.lanes.find((candidate) => candidate.key === key && candidate.state === "running");
		if (!lane) return;
		// Only a writer lane has anything to integrate; a read-only lane is finished when it reports.
		lane.state = lane.kind === "implement" ? "returned" : "integrated";
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
					if (params.slices_done !== undefined) campaign.slicesDone = params.slices_done;
					if (params.slices_total !== undefined) campaign.slicesTotal = params.slices_total;
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
			const lane = campaign.lanes.find((candidate) => candidate.key === params.key);
			if (!lane) throw new Error(`no lane named ${params.key}; open lanes: ${laneSummary(campaign)}`);
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
