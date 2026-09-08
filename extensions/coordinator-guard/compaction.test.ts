/**
 * The wiring, not the policy: policy.test.ts decides when a slice boundary should compact,
 * and this drives the extension itself to prove the boundary is actually reached.
 *
 * Compaction aborts whatever is running, so where it is called from is the whole risk. These
 * tests register a campaign, dispatch a lane, integrate it, and then assert that nothing is
 * compacted until the run has settled, and that what is compacted carries the ledger.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import coordinatorGuard from "./pi-extension.ts";

const WORKTREE = "/Users/dev/.agents/worktrees/demo-20260101";
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

interface CompactCall {
	customInstructions?: string;
	onComplete?: (result: unknown) => void;
	onError?: (error: Error) => void;
}

function harness() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const compactCalls: CompactCall[] = [];
	const sent: unknown[] = [];
	let usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined = {
		tokens: 150_000,
		contextWindow: 200_000,
		percent: 75,
	};
	let compactThrows = false;

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, options);
		},
		registerShortcut() {},
		registerEntryRenderer() {},
		registerMessageRenderer() {},
		registerMarkdownTransformer() {},
		appendEntry() {},
		sendMessage(message: unknown) {
			sent.push(message);
		},
	};

	const ctx = {
		hasUI: false,
		mode: "print",
		cwd: WORKTREE,
		ui: { setStatus() {}, notify() {}, theme: { fg: (_key: string, text: string) => text } },
		sessionManager: { getBranch: () => [] },
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => usage,
		waitForIdle: async () => {},
		compact(options: CompactCall) {
			compactCalls.push(options);
			if (compactThrows) throw new Error("Nothing to compact (session too small)");
		},
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	coordinatorGuard(pi as any);

	const emit = async (event: string, payload: Record<string, unknown> = {}) => {
		for (const handler of handlers.get(event) ?? []) {
			await handler({ type: event, ...payload }, ctx);
		}
	};
	const call = (name: string, params: Record<string, unknown>) =>
		tools.get(name)?.execute("call-1", params, undefined, undefined, ctx) ?? Promise.reject(new Error(`no tool ${name}`));

	return {
		emit,
		call,
		compactCalls,
		sent,
		command: (args: string) => commands.get("campaign")?.handler(args, ctx) ?? Promise.reject(new Error("no command")),
		setUsage(next: typeof usage) {
			usage = next;
		},
		throwOnCompact(next: boolean) {
			compactThrows = next;
		},
	};
}

const TASK = [
	`ROUTE: s1-parser | class 1 | claude-bridge/claude-sonnet-5:medium | mechanical single-file transcription`,
	`Implement slice S1 in ${WORKTREE} at exact HEAD ${HEAD}. Stop and report if HEAD differs.`,
	"Commit locally on your branch and never push, never run gh, never open a PR.",
].join("\n");

async function campaignWithLane(pi: ReturnType<typeof harness>) {
	// The judge spends a model call on every dispatch, and this test is about the compaction
	// boundary rather than about reading prompts, so the structural half runs alone.
	await pi.command("judge off");
	await pi.call("coordinator_campaign", {
		action: "start",
		slug: "demo",
		worktree: WORKTREE,
		plan_path: `${WORKTREE}/plan.html`,
		slices_total: 3,
		authorized: "implement approved slices; commit; push; open and update the PR",
	});
	await pi.emit("tool_call", {
		toolName: "subagent",
		toolCallId: "tc-1",
		input: {
			async: true,
			workflowScript: `return runs.run('s1-parser', { agent: 'campaign-worker', model: 'claude-bridge/claude-sonnet-5:medium', task: \`${TASK}\` })`,
		},
	});
}

test("an integrated slice compacts once the run settles, and not before", async () => {
	const pi = harness();
	await campaignWithLane(pi);

	// Recording the integration is not the moment to compact: the turn that recorded it is
	// still running, and compaction aborts the run it is called from.
	await pi.call("coordinator_lane", { action: "integrated", key: "s1-parser", slice: "done" });
	assert.equal(pi.compactCalls.length, 0, "compaction must not fire inside the turn that integrated the lane");

	// agent_end is not it either: pi may still retry or compact after it.
	await pi.emit("agent_end", { messages: [] });
	assert.equal(pi.compactCalls.length, 0);

	await pi.emit("agent_settled");
	assert.equal(pi.compactCalls.length, 1, "a settled run at a slice boundary compacts");

	const instructions = pi.compactCalls[0]?.customInstructions ?? "";
	assert.match(instructions, /CAMPAIGN demo/);
	assert.match(instructions, /1 of 3/);
	assert.match(instructions, /s1-parser/);

	// One boundary is one compaction: settling again with nothing integrated since must not
	// spend another summary of the same transcript.
	pi.compactCalls[0]?.onComplete?.(undefined);
	await pi.emit("agent_settled");
	assert.equal(pi.compactCalls.length, 1);
});

test("the campaign carries on when a compaction is off, refused by the floor, or failing", async () => {
	const off = harness();
	await campaignWithLane(off);
	await off.command("compact off");
	await off.call("coordinator_lane", { action: "integrated", key: "s1-parser", slice: "done" });
	await off.emit("agent_settled");
	assert.equal(off.compactCalls.length, 0, "the user's switch is the user's");

	const early = harness();
	await campaignWithLane(early);
	early.setUsage({ tokens: 20_000, contextWindow: 200_000, percent: 10 });
	await early.call("coordinator_lane", { action: "integrated", key: "s1-parser", slice: "done" });
	await early.emit("agent_settled");
	assert.equal(early.compactCalls.length, 0, "a summary that replaces a transcript that still fits is a loss");

	// A failed compaction is reported and dropped: the campaign runs uncompacted rather than
	// hitting the same wall at every slice, and the boundary is not retried silently.
	const failing = harness();
	await campaignWithLane(failing);
	await failing.call("coordinator_lane", { action: "integrated", key: "s1-parser", slice: "done" });
	await failing.emit("agent_settled");
	assert.equal(failing.compactCalls.length, 1);
	failing.compactCalls[0]?.onError?.(new Error("Nothing to compact (session too small)"));
	await failing.emit("agent_settled");
	assert.equal(failing.compactCalls.length, 1);
});

test("a partial integration is not a finished slice, so it does not compact", async () => {
	// The instructions tell the summarizer an integrated slice is finished work whose diffs and
	// command output can go. That is true of "done" and of "retry", which re-ran a slice already
	// counted; it is the opposite of "partial", which says this slice still needs work, and
	// throwing away its detail is throwing away what the next dispatch is built from.
	const partial = harness();
	await campaignWithLane(partial);
	await partial.call("coordinator_lane", { action: "integrated", key: "s1-parser", slice: "partial" });
	await partial.emit("agent_settled");
	assert.equal(partial.compactCalls.length, 0);

	const retry = harness();
	await campaignWithLane(retry);
	await retry.call("coordinator_lane", { action: "integrated", key: "s1-parser", slice: "retry" });
	await retry.emit("agent_settled");
	assert.equal(retry.compactCalls.length, 1, "a re-run slice is still work that landed and is finished");
});

test("a boundary belongs to the campaign that made it", async () => {
	// An integration below the floor leaves the boundary pending. If the campaign then closes,
	// the next campaign in the same session would open on a compaction it never earned, stamped
	// with a lane key belonging to work it has nothing to do with.
	const pi = harness();
	await campaignWithLane(pi);
	pi.setUsage({ tokens: 20_000, contextWindow: 200_000, percent: 10 });
	await pi.call("coordinator_lane", { action: "integrated", key: "s1-parser", slice: "done" });
	await pi.emit("agent_settled");
	assert.equal(pi.compactCalls.length, 0, "below the floor nothing compacts, and the boundary is still pending");

	await pi.command("close");
	await pi.call("coordinator_campaign", {
		action: "start",
		slug: "second",
		worktree: WORKTREE,
		slices_total: 2,
		authorized: "implement approved slices",
	});
	pi.setUsage({ tokens: 150_000, contextWindow: 200_000, percent: 75 });
	await pi.emit("agent_settled");
	assert.equal(pi.compactCalls.length, 0, "a new campaign has finished no slice of its own");
});

test("a manual compaction that cannot start leaves nothing stuck behind it", async () => {
	// /campaign compact now deliberately skips the floor, so it is the path most likely to reach
	// a session pi refuses to compact. A throw there used to leave the guard believing a
	// compaction was running, which parks the continuation loop for ten minutes.
	const pi = harness();
	await campaignWithLane(pi);
	pi.throwOnCompact(true);
	await pi.command("compact now");
	assert.equal(pi.compactCalls.length, 1);

	pi.throwOnCompact(false);
	await pi.call("coordinator_lane", { action: "integrated", key: "s1-parser", slice: "done" });
	await pi.emit("agent_settled");
	assert.equal(pi.compactCalls.length, 2, "the next real boundary still compacts");

	// And a second request while one is genuinely in flight is one compaction, not two.
	await pi.command("compact now");
	assert.equal(pi.compactCalls.length, 2);
});
