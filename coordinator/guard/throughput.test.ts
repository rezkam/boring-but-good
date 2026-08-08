import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { rateFor, readThroughput } from "./throughput.ts";

function sessionRoot(entries: string[][]): { root: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "guard-throughput-"));
	entries.forEach((lines, index) => {
		const dir = join(root, `project-${index}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "session.jsonl"), `${lines.join("\n")}\n`);
	});
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A tick with no usage, which is what supplies the previous timestamp. */
function tick(seconds: number): string {
	return JSON.stringify({ timestamp: new Date(seconds * 1000).toISOString(), type: "message" });
}

function assistant(seconds: number, provider: string, model: string, output: number): string {
	return JSON.stringify({
		timestamp: new Date(seconds * 1000).toISOString(),
		message: { role: "assistant", provider, model, usage: { output } },
	});
}

/** n samples of a model producing `output` tokens in `seconds` each. */
function samples(provider: string, model: string, count: number, output: number, seconds: number): string[] {
	const lines: string[] = [];
	let clock = 1000;
	for (let index = 0; index < count; index++) {
		lines.push(tick(clock));
		clock += seconds;
		lines.push(assistant(clock, provider, model, output));
	}
	return lines;
}

test("throughput is output tokens over the gap, once there are enough samples", () => {
	const { root, cleanup } = sessionRoot([samples("claude-bridge", "claude-opus-5", 6, 600, 10)]);
	try {
		const measured = readThroughput(root);
		const rate = measured.get("claude-bridge/claude-opus-5");
		assert.ok(rate, "the model should be measured");
		assert.equal(rate.samples, 6);
		assert.equal(Math.round(rate.tokensPerSecond), 60);
	} finally {
		cleanup();
	}
});

test("a model with too few samples reports nothing rather than noise", () => {
	const { root, cleanup } = sessionRoot([samples("openai-codex", "gpt-5.6-luna", 4, 600, 10)]);
	try {
		assert.equal(readThroughput(root).has("openai-codex/gpt-5.6-luna"), false);
	} finally {
		cleanup();
	}
});

test("implausible gaps and tiny outputs are dropped, not averaged in", () => {
	const lines = [
		...samples("claude-bridge", "claude-opus-5", 6, 600, 10),
		// A twenty minute gap: the user went away, this is not generation time.
		tick(50_000),
		assistant(52_000, "claude-bridge", "claude-opus-5", 600),
		// A ten token reply: dominated by fixed overhead.
		tick(60_000),
		assistant(60_001, "claude-bridge", "claude-opus-5", 10),
	];
	const { root, cleanup } = sessionRoot([lines]);
	try {
		const rate = readThroughput(root).get("claude-bridge/claude-opus-5");
		assert.equal(rate?.samples, 6, "only the plausible samples count");
		assert.equal(Math.round(rate?.tokensPerSecond ?? 0), 60);
	} finally {
		cleanup();
	}
});

test("samples accumulate across sessions", () => {
	const { root, cleanup } = sessionRoot([
		samples("claude-bridge", "claude-opus-5", 3, 600, 10),
		samples("claude-bridge", "claude-opus-5", 3, 600, 10),
	]);
	try {
		assert.equal(readThroughput(root).get("claude-bridge/claude-opus-5")?.samples, 6);
	} finally {
		cleanup();
	}
});

test("a rate is found for a pin recorded under a different provider", () => {
	const { root, cleanup } = sessionRoot([samples("openai-codex-work", "gpt-5.6-terra", 6, 500, 10)]);
	try {
		const measured = readThroughput(root);
		assert.ok(rateFor(measured, "openai-codex/gpt-5.6-terra:xhigh"), "the bare model name is what matches");
		assert.equal(rateFor(measured, "claude-bridge/claude-opus-5:high"), null);
	} finally {
		cleanup();
	}
});

test("a missing or unreadable sessions directory measures nothing instead of throwing", () => {
	assert.equal(readThroughput(join(tmpdir(), "guard-throughput-does-not-exist")).size, 0);
});
