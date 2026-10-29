import assert from "node:assert/strict";
import { test } from "node:test";
import codexFastMode from "./index.ts";

function setup() {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const notices: string[] = [];
	const statuses: (string | undefined)[] = [];
	codexFastMode({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
	} as any);
	const ctx = {
		model: { provider: "openai-codex", api: "openai-codex-responses" },
		hasUI: true,
		ui: { notify: (text: string) => notices.push(text), setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			theme: { fg: (_color: string, value: string) => value } },
	};
	return { ctx, statuses, notices, command: (args: string) => commands.get("codex-fast")?.handler(args, ctx), emit: (name: string, event = {}) => handlers.get(name)!(event, ctx) };
}

test("requests priority while preserving the rest of the payload", async () => {
	const { emit, command } = setup();
	await command("on");
	const payload = { model: "test-model", input: [], reasoning: { effort: "high" }, service_tier: "auto" };
	assert.deepEqual(emit("before_provider_request", { payload }), { ...payload, service_tier: "priority" });
	assert.equal(payload.service_tier, "auto");
});

test("does not change other providers or APIs", async () => {
	const { ctx, emit, command } = setup();
	await command("on");
	ctx.model.provider = "other";
	assert.equal(emit("before_provider_request", { payload: {} }), undefined);
	ctx.model.provider = "openai-codex";
	ctx.model.api = "openai-responses";
	assert.equal(emit("before_provider_request", { payload: {} }), undefined);
});

test("footer follows startup and model selection including switching back", async () => {
	const { ctx, emit, command, statuses } = setup();
	await command("on");
	statuses.length = 0;
	emit("session_start");
	emit("model_select", { model: { provider: "other", api: "other" } });
	emit("model_select", { model: ctx.model });
	assert.deepEqual(statuses, ["Codex fast: priority", undefined, "Codex fast: priority"]);
	ctx.hasUI = false;
	emit("session_start");
	assert.equal(statuses.length, 3);
});


test("off restores normal requests across model switches and on restores priority", async () => {
	const { ctx, emit, command, statuses } = setup();
	emit("session_start");
	await command("on");
	await command("off");
	assert.equal(statuses.at(-1), undefined);
	const payload = { model: "test-model", input: [] };
	assert.equal(emit("before_provider_request", { payload }), undefined);
	emit("model_select", { model: { provider: "other", api: "other" } });
	emit("model_select", { model: ctx.model });
	assert.equal(statuses.at(-1), undefined);
	assert.equal(emit("before_provider_request", { payload }), undefined);
	await command("on");
	assert.equal(statuses.at(-1), "Codex fast: priority");
	assert.deepEqual(emit("before_provider_request", { payload }), { ...payload, service_tier: "priority" });
});

test("status and invalid arguments leave the setting unchanged", async () => {
	const { command, emit, notices } = setup();
	await command("on");
	await command("");
	assert.match(notices.at(-1)!, /on/i);
	await command("off");
	await command("invalid");
	assert.match(notices.at(-1)!, /Usage:/);
	assert.equal(emit("before_provider_request", { payload: {} }), undefined);
	await command("");
	assert.match(notices.at(-1)!, /off/i);
});
