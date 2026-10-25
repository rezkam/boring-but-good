import assert from "node:assert/strict";
import { test } from "node:test";
import goalExtension from "./index.ts";

const ABORT_ERROR = { stopReason: "error", errorMessage: "This operation was aborted" };

async function setup(options: { budget?: number } = {}) {
	const handlers = new Map<string, Function>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const messages: any[] = [];
	const ctx = {
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getSessionId: () => "session-a", getBranch: () => entries },
		// Accepting every confirmation makes any pause prompt on abort show up as a paused goal.
		ui: { setStatus() {}, notify() {}, theme: { fg: (_color: string, text: string) => text }, confirm: async () => true },
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
	await emit("session_start");
	await tool("create_goal", { objective: "Finish the requested work", token_budget: options.budget });
	return {
		emit,
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
	test(`${label} keeps the goal active and continues after the next turn`, async () => {
		const app = await setup();
		await app.turn(abort);
		assert.equal(await app.status(), "active");
		assert.equal(app.continuations(), 0);
		await app.turn({ stopReason: "stop" });
		assert.equal(await app.status(), "active");
		assert.equal(app.continuations(), 1);
	});
}

test("a failed turn continues the goal until three fail in a row", async () => {
	const app = await setup();
	for (const continued of [1, 2]) {
		await app.turn({ stopReason: "error", errorMessage: "WebSocket error" });
		assert.equal(await app.status(), "active");
		assert.equal(app.continuations(), continued);
	}
	await app.turn({ stopReason: "error", errorMessage: "WebSocket error" });
	assert.equal(await app.status(), "blocked");
	assert.equal(app.continuations(), 2);
});

test("a successful turn or a resume starts the failure count again", async () => {
	const app = await setup();
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

test("a usage limit stops the goal at once", async () => {
	const app = await setup();
	await app.turn({ stopReason: "error", errorMessage: "Rate limit exceeded" });
	assert.equal(await app.status(), "usageLimited");
});

test("an abort does not bypass the token budget", async () => {
	const app = await setup({ budget: 1 });
	await app.turn({ ...ABORT_ERROR, usage: { input: 1, output: 1, totalTokens: 2 } });
	assert.equal(await app.status(), "budgetLimited");
});

for (const aborted of [false, true]) {
	test(`a ${aborted ? "cancelled" : "failed"} compaction after an abort ${aborted ? "leaves the goal waiting" : "continues the goal"}`, async () => {
		const app = await setup();
		await app.turn(ABORT_ERROR);
		await app.emit("session_compact_failed", {
			reason: "manual", aborted, willRetry: false, errorMessage: aborted ? undefined : "Compaction failed: summary failed",
		});
		assert.equal(await app.status(), "active");
		assert.equal(app.continuations(), aborted ? 0 : 1);
	});
}
