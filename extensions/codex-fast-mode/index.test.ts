import assert from "node:assert/strict";
import { test } from "node:test";
import codexFastMode from "./index.ts";

function setup() {
	const handlers = new Map<string, Function>();
	const statuses: (string | undefined)[] = [];
	codexFastMode({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
	const ctx = {
		model: { provider: "openai-codex", api: "openai-codex-responses" },
		hasUI: true,
		ui: { setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			theme: { fg: (_color: string, value: string) => value } },
	};
	return { ctx, statuses, emit: (name: string, event = {}) => handlers.get(name)!(event, ctx) };
}

test("requests priority while preserving the rest of the payload", () => {
	const { emit } = setup();
	const payload = { model: "test-model", input: [], reasoning: { effort: "high" }, service_tier: "auto" };
	assert.deepEqual(emit("before_provider_request", { payload }), { ...payload, service_tier: "priority" });
	assert.equal(payload.service_tier, "auto");
});

test("does not change other providers or APIs", () => {
	const { ctx, emit } = setup();
	ctx.model.provider = "other";
	assert.equal(emit("before_provider_request", { payload: {} }), undefined);
	ctx.model.provider = "openai-codex";
	ctx.model.api = "openai-responses";
	assert.equal(emit("before_provider_request", { payload: {} }), undefined);
});

test("footer follows startup and model selection including switching back", () => {
	const { ctx, emit, statuses } = setup();
	emit("session_start");
	emit("model_select", { model: { provider: "other", api: "other" } });
	emit("model_select", { model: ctx.model });
	assert.deepEqual(statuses, ["Codex fast: priority", undefined, "Codex fast: priority"]);
	ctx.hasUI = false;
	emit("session_start");
	assert.equal(statuses.length, 3);
});
