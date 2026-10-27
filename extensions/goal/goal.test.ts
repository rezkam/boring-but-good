import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import goalExtension from "./index.ts";

const ABORT_ERROR = { stopReason: "error", errorMessage: "This operation was aborted" };

async function setup(t: TestContext, options: { budget?: number; hasUI?: boolean } = {}) {
	const handlers = new Map<string, Function>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const messages: any[] = [];
	const statuses: (string | undefined)[] = [];
	const ctx = {
		hasUI: options.hasUI ?? true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getSessionId: () => "session-a", getBranch: () => entries },
		// Accepting every confirmation makes any pause prompt on abort show up as a paused goal.
		ui: { setStatus(_key: string, text: string | undefined) { statuses.push(text); }, notify() {}, theme: { fg: (_color: string, text: string) => text }, confirm: async () => true },
	};
	goalExtension({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: any) => messages.push(message),
	} as any);
	const emit = (name: string, data = {}) => handlers.get(name)?.({ type: name, ...data }, ctx);
	const tool = (name: string, params = {}) => tools.get(name).execute("call", params, undefined, undefined, ctx);
	t.after(() => emit("session_shutdown"));
	await emit("session_start");
	await tool("create_goal", { objective: "Finish the requested work", token_budget: options.budget });
	return {
		emit,
		ctx,
		entries,
		statuses,
		tool,
		footer: () => statuses.at(-1),
		turn: async (message: object) => {
			await emit("agent_start");
			await emit("agent_end", { messages: [{ role: "assistant", ...message }] });
		},
		goalCommand: (args: string) => commands.get("goal").handler(args, ctx),
		status: async () => (await tool("get_goal")).details.goal.status,
		continuations: () => messages.filter(m => m.customType === "goal-continuation").length,
	};
}

for (const [label, abort] of [["an abort", { stopReason: "aborted" }], ["an abort recorded as an error", ABORT_ERROR]] as const) {
	test(`${label} keeps the goal active and continues after the next turn`, async (t) => {
		const app = await setup(t);
		await app.turn(abort);
		assert.equal(await app.status(), "active");
		assert.equal(app.continuations(), 0);
		await app.turn({ stopReason: "stop" });
		assert.equal(await app.status(), "active");
		assert.equal(app.continuations(), 1);
	});
}

test("a failed turn continues the goal until three fail in a row", async (t) => {
	const app = await setup(t);
	for (const continued of [1, 2]) {
		await app.turn({ stopReason: "error", errorMessage: "WebSocket error" });
		assert.equal(await app.status(), "active");
		assert.equal(app.continuations(), continued);
	}
	await app.turn({ stopReason: "error", errorMessage: "WebSocket error" });
	assert.equal(await app.status(), "blocked");
	assert.equal(app.continuations(), 2);
});

test("a successful turn or a resume starts the failure count again", async (t) => {
	const app = await setup(t);
	const fail = () => app.turn({ stopReason: "error", errorMessage: "fetch failed" });
	await fail();
	await fail();
	await app.turn({ stopReason: "stop" });
	await fail();
	await fail();
	assert.equal(await app.status(), "active");
	await fail();
	assert.equal(await app.status(), "blocked");
	await app.goalCommand("resume");
	await fail();
	await fail();
	assert.equal(await app.status(), "active");
});

test("a usage limit stops the goal at once", async (t) => {
	const app = await setup(t);
	await app.turn({ stopReason: "error", errorMessage: "Rate limit exceeded" });
	assert.equal(await app.status(), "usageLimited");
});

test("an abort does not bypass the token budget", async (t) => {
	const app = await setup(t, { budget: 1 });
	await app.turn({ ...ABORT_ERROR, usage: { input: 1, output: 1, totalTokens: 2 } });
	assert.equal(await app.status(), "budgetLimited");
});

for (const aborted of [false, true]) {
	test(`a ${aborted ? "cancelled" : "failed"} compaction after an abort ${aborted ? "leaves the goal waiting" : "continues the goal"}`, async (t) => {
		const app = await setup(t);
		await app.turn(ABORT_ERROR);
		await app.emit("session_compact_failed", {
			reason: "manual", aborted, willRetry: false, errorMessage: aborted ? undefined : "Compaction failed: summary failed",
		});
		assert.equal(await app.status(), "active");
		assert.equal(app.continuations(), aborted ? 0 : 1);
	});
}

test("the active footer ticks during long turns, compaction, and idle time without persisting every tick", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 100_000 });
	const app = await setup(t);
	assert.equal(app.footer(), "Pursuing goal (0s)");
	const entries = app.entries.length;
	await app.emit("agent_start");
	t.mock.timers.tick(5_000);
	assert.equal(app.footer(), "Pursuing goal (5s)");
	await app.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
	const afterTurn = app.entries.length;
	assert.equal(afterTurn, entries + 1);
	t.mock.timers.tick(65_000);
	assert.equal(app.footer(), "Pursuing goal (1m 10s)");
	assert.equal(app.entries.length, afterTurn);
	assert.equal((await app.tool("get_goal")).details.goal.timeUsedSeconds, 70);
	assert.equal(app.continuations(), 0);
});

test("pause stops the footer timer and resume restarts it without counting the pause", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 100_000 });
	const app = await setup(t);
	t.mock.timers.tick(2_000);
	await app.goalCommand("pause");
	const updates = app.statuses.length;
	t.mock.timers.tick(10_000);
	assert.equal(app.footer(), "Goal paused (/goal resume)");
	assert.equal(app.statuses.length, updates);
	await app.goalCommand("resume");
	t.mock.timers.tick(1_000);
	assert.equal(app.footer(), "Pursuing goal (3s)");
});

for (const action of ["clear", "complete", "shutdown"] as const) {
	test(`${action} stops the footer timer`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 100_000 });
		const app = await setup(t);
		if (action === "clear") await app.goalCommand("clear");
		if (action === "complete") await app.tool("update_goal", { status: "complete" });
		if (action === "shutdown") await app.emit("session_shutdown");
		const updates = app.statuses.length;
		t.mock.timers.tick(5_000);
		assert.equal(app.statuses.length, updates);
	});
}

test("reconstructing an active goal replaces the timer and switching to an empty branch stops it", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 100_000 });
	const app = await setup(t);
	await app.emit("session_start");
	await app.emit("session_tree");
	const updates = app.statuses.length;
	t.mock.timers.tick(1_000);
	assert.equal(app.footer(), "Pursuing goal (1s)");
	assert.equal(app.statuses.length, updates + 1);
	app.entries.length = 0;
	await app.emit("session_start");
	assert.equal(app.footer(), undefined);
	const cleared = app.statuses.length;
	t.mock.timers.tick(5_000);
	assert.equal(app.statuses.length, cleared);
});

test("headless and token-budget goals do not schedule elapsed-time footer refreshes", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 100_000 });
	const headless = await setup(t, { hasUI: false });
	const budgeted = await setup(t, { budget: 1_000 });
	const updates = budgeted.statuses.length;
	t.mock.timers.tick(5_000);
	assert.equal(headless.statuses.length, 0);
	assert.equal(budgeted.statuses.length, updates);
	assert.equal((await headless.tool("get_goal")).details.goal.timeUsedSeconds, 5);
});
