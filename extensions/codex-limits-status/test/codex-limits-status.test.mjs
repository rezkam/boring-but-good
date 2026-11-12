import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const authDir = mkdtempSync(join(tmpdir(), "codex-status-test-"));
writeFileSync(join(authDir, "auth.json"), JSON.stringify({
	"openai-codex": { access: "test-token", accountId: "test-account" },
}));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = authDir;
const { default: extension } = await import("../index.ts");
if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
const originalFetch = globalThis.fetch;
const shutdowns = [];
afterEach(async () => {
	for (const shutdown of shutdowns.splice(0)) await shutdown();
	globalThis.fetch = originalFetch;
});
after(() => { rmSync(authDir, { recursive: true, force: true }); });

function harness(payload = {}) {
	const handlers = new Map();
	let status;
	const colors = [];
	const ctx = {
		model: { provider: "openai-codex" },
		ui: {
			setStatus(key, value) {
				assert.equal(key, "codex-limits");
				status = value;
			},
			theme: { fg(color, text) { colors.push([color, text]); return text; } },
		},
	};
	globalThis.fetch = async () => ({ ok: true, json: async () => payload });
	extension({ on(name, handler) { handlers.set(name, handler); } });
	shutdowns.push(() => handlers.get("session_shutdown")?.({}, ctx));
	return {
		ctx, colors,
		get status() { return status; },
		async emit(name, event = {}, context = ctx) { await handlers.get(name)(event, context); },
	};
}

test("shows a single limit with a compact reset countdown", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
	const app = harness({ rate_limit: {
		primary_window: {
			used_percent: 69, limit_window_seconds: 604800,
			reset_at: Date.now() / 1000 + 2 * 86400 + 3 * 3600 + 10 * 60,
		},
	} });
	await app.emit("session_start");
	assert.equal(app.status, "Codex used 69% (resets in 2d3h10m)");
});

test("preserves the reset time on usage-only headers and accepts reset-after headers", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
	const app = harness({ rate_limit: {
		primary_window: { used_percent: 69, reset_at: Date.now() / 1000 + 3600 },
	} });
	await app.emit("session_start");
	await app.emit("after_provider_response", { headers: { "x-codex-primary-used-percent": "70" } });
	assert.equal(app.status, "Codex used 70% (resets in 1h0m)");
	await app.emit("after_provider_response", { headers: {
		"x-codex-primary-used-percent": "71",
		"x-codex-primary-reset-after-seconds": "600",
	} });
	assert.equal(app.status, "Codex used 71% (resets in 10m)");
});

test("ticks the countdown while idle and stops on session shutdown", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1800000000000 });
	const app = harness({ rate_limit: {
		primary_window: { used_percent: 69, reset_at: Date.now() / 1000 + 600 },
	} });
	await app.emit("session_start");
	assert.equal(app.status, "Codex used 69% (resets in 10m)");
	t.mock.timers.tick(60000);
	assert.equal(app.status, "Codex used 69% (resets in 9m)");
	await app.emit("session_shutdown");
	t.mock.timers.tick(60000);
	assert.equal(app.status, "Codex used 69% (resets in 9m)");
});

test("shows percent used and warns at high usage", async () => {
	const app = harness({ rate_limit: {
		primary_window: { used_percent: 20, limit_window_seconds: 18000 },
		secondary_window: { used_percent: 92, limit_window_seconds: 604800 },
	} });
	await app.emit("session_start");
	assert.equal(app.status, "Codex used 5h 20% · 7d 92%");
	assert.ok(app.colors.some(([color, text]) => color === "success" && text === "20%"));
	assert.ok(app.colors.some(([color, text]) => color === "error" && text === "92%"));
});

test("shows only the weekly limit whether it is primary or secondary", async () => {
	for (const slot of ["primary_window", "secondary_window"]) {
		const app = harness({ rate_limit: {
			[slot]: { used_percent: 36, limit_window_seconds: 604800 },
		} });
		await app.emit("session_start");
		assert.equal(app.status, "Codex used 36%", slot);
	}
});

test("uses header window durations for weekly-only usage and preserves them on partial updates", async () => {
	const app = harness();
	await app.emit("after_provider_response", { headers: {
		"x-codex-primary-used-percent": ["81"],
		"x-codex-primary-window-minutes": "10080",
	} });
	assert.equal(app.status, "Codex used 81%");
	assert.ok(app.colors.some(([color, text]) => color === "warning" && text === "81%"));
	await app.emit("after_provider_response", { headers: { "x-codex-primary-used-percent": "82" } });
	assert.equal(app.status, "Codex used 82%");
	await app.emit("after_provider_response", { headers: {} });
	assert.equal(app.status, "Codex used 82%");
	await app.emit("after_provider_response", { headers: { "x-codex-secondary-used-percent": "10" } });
	assert.equal(app.status, "Codex used 7d 82% · 7d 10%");
});

test("clamps usage, keeps zero usage visible, and falls back to legacy window labels", async () => {
	const app = harness({ rate_limit: {
		primary_window: { used_percent: -3 },
		secondary_window: { used_percent: 120 },
	} });
	await app.emit("session_start");
	assert.equal(app.status, "Codex used 5h 0% · 7d 100%");
});

test("ignores null and invalid windows instead of showing placeholders", async () => {
	const app = harness({ rate_limit: {
		primary_window: null,
		secondary_window: { used_percent: 0, limit_window_seconds: 604800 },
	} });
	await app.emit("session_start");
	assert.equal(app.status, "Codex used 0%");
	await app.emit("after_provider_response", { headers: { "x-codex-primary-used-percent": "invalid" } });
	assert.equal(app.status, "Codex used 0%");
});

test("keeps a cached weekly label when headers do not report a duration", async () => {
	const app = harness({ rate_limit: {
		primary_window: { used_percent: 36, limit_window_seconds: 604800 },
	} });
	await app.emit("session_start");
	await app.emit("after_provider_response", { headers: { "x-codex-primary-used-percent": "39" } });
	assert.equal(app.status, "Codex used 39%");
	await app.emit("after_provider_response", { headers: { "x-codex-secondary-used-percent": "10" } });
	assert.equal(app.status, "Codex used 7d 39% · 7d 10%");
});

test("formats short countdowns, rounds up partial minutes, and never shows negative time", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
	for (const [seconds, suffix] of [[86400, "1d0h0m"], [3660, "1h1m"], [1, "1m"], [-60, "0m"]]) {
		const app = harness({ rate_limit: {
			primary_window: { used_percent: 69, reset_at: Date.now() / 1000 + seconds },
		} });
		await app.emit("session_start");
		assert.equal(app.status, `Codex used 69% (resets in ${suffix})`);
	}
});

test("keeps dual window labels with their own reset countdowns", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
	const app = harness({ rate_limit: {
		primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: Date.now() / 1000 + 600 },
		secondary_window: { used_percent: 69, limit_window_seconds: 604800, reset_at: Date.now() / 1000 + 86400 },
	} });
	await app.emit("session_start");
	assert.equal(app.status, "Codex used 5h 20% (resets in 10m) · 7d 69% (resets in 1d0h0m)");
});

test("shows usage only for providers starting with openai-codex", async () => {
	for (const provider of ["openai-codex", "openai-codex-team", "openai-codex/custom"]) {
		const app = harness({ rate_limit: { primary_window: { used_percent: 69 } } });
		app.ctx.model = { provider, id: "custom-model", api: "openai-responses" };
		await app.emit("model_select");
		assert.equal(app.status, "Codex used 69%", provider);
	}
});

test("does not fetch or show usage for other providers even with Codex model IDs or APIs", async () => {
	for (const model of [
		{ provider: "anthropic" },
		{ provider: "openai", id: "gpt-codex", api: "openai-codex-responses" },
		{ provider: "custom-codex", id: "codex" },
		{ provider: "proxy-openai-codex", api: "openai-codex-responses" },
		{ id: "codex", api: "openai-codex-responses" },
		undefined,
	]) {
		const app = harness();
		app.ctx.model = model;
		let requests = 0;
		globalThis.fetch = async () => { requests += 1; return { ok: false }; };
		await app.emit("model_select");
		assert.equal(app.status, undefined, JSON.stringify(model));
		await app.emit("after_provider_response", { headers: { "x-codex-primary-used-percent": "69" } });
		assert.equal(app.status, undefined, JSON.stringify(model));
		assert.equal(requests, 0, JSON.stringify(model));
	}
});

test("a late Codex usage response cannot restore the status after switching providers", async () => {
	const app = harness();
	let resolveFetch;
	globalThis.fetch = () => new Promise(resolve => { resolveFetch = resolve; });
	const pendingStart = app.emit("session_start");
	const otherContext = { ...app.ctx, model: { provider: "anthropic" } };
	await app.emit("model_select", {}, otherContext);
	assert.equal(app.status, undefined);
	resolveFetch({ ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 69 } } }) });
	await pendingStart;
	assert.equal(app.status, undefined);
});

test("keeps the loading status on a transient network failure", async () => {
	const app = harness();
	globalThis.fetch = async () => { throw new Error("offline"); };
	await app.emit("session_start");
	assert.equal(app.status, "Codex limits …");
});
