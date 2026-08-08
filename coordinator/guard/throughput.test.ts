import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { rateFor, readThroughput, reorderByThroughput } from "./throughput.ts";

function sessionRoot(entries: string[][], nested = false): { root: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "guard-throughput-"));
	entries.forEach((lines, index) => {
		// The nested layout is where pi keeps subagent transcripts, so campaign workers and
		// reviewers only appear there.
		const dir = nested ? join(root, `project-${index}`, "session-stem", "abc123", "run-0") : join(root, `project-${index}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "session.jsonl"), `${lines.join("\n")}\n`);
	});
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function effortChange(seconds: number, level: string): string {
	return JSON.stringify({ timestamp: new Date(seconds * 1000).toISOString(), type: "thinking_level_change", thinkingLevel: level });
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
function samples(provider: string, model: string, count: number, output: number, seconds: number, effort = "high"): string[] {
	const lines: string[] = [effortChange(999, effort)];
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
		const rate = measured.get("claude-bridge/claude-opus-5:high");
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
		assert.equal(readThroughput(root).has("openai-codex/gpt-5.6-luna:high"), false);
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
		const rate = readThroughput(root).get("claude-bridge/claude-opus-5:high");
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
		assert.equal(readThroughput(root).get("claude-bridge/claude-opus-5:high")?.samples, 6);
	} finally {
		cleanup();
	}
});

test("a rate is found for a pin recorded under a different provider", () => {
	const { root, cleanup } = sessionRoot([samples("openai-codex-work", "gpt-5.6-terra", 6, 500, 10, "xhigh")]);
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

test("subagent transcripts nested under a run directory are measured", () => {
	// Campaign workers and reviewers only ever appear here, so a top-level-only reader
	// reported no measurement for exactly the models the tiers care about.
	const { root, cleanup } = sessionRoot([samples("claude-bridge", "claude-opus-5", 6, 600, 10, "xhigh")], true);
	try {
		assert.equal(readThroughput(root).get("claude-bridge/claude-opus-5:xhigh")?.samples, 6);
	} finally {
		cleanup();
	}
});

test("one model at two efforts is two measurements, never one mixed rate", () => {
	const lines = [
		...samples("claude-bridge", "claude-opus-5", 6, 600, 10, "low"),
		...samples("claude-bridge", "claude-opus-5", 6, 300, 10, "xhigh"),
	];
	const { root, cleanup } = sessionRoot([lines]);
	try {
		const measured = readThroughput(root);
		assert.equal(Math.round(measured.get("claude-bridge/claude-opus-5:low")?.tokensPerSecond ?? 0), 60);
		assert.equal(Math.round(measured.get("claude-bridge/claude-opus-5:xhigh")?.tokensPerSecond ?? 0), 30);

		// And a pin resolves to its own effort, not the other one.
		assert.equal(Math.round(rateFor(measured, "claude-bridge/claude-opus-5:xhigh")?.tokensPerSecond ?? 0), 30);
		assert.equal(rateFor(measured, "claude-bridge/claude-opus-5:medium"), null, "an unmeasured effort is unmeasured");
	} finally {
		cleanup();
	}
});

test("auto keeps an unmeasured entry where it is, sorting only the measured ones", () => {
	// The contradiction this pins: a measured fallback must not jump ahead of an unmeasured
	// preferred entry, because that treats missing data as slow.
	const measured = new Map([
		["openai-codex/gpt-5.6-luna:high", { tokensPerSecond: 39, samples: 60 }],
		["openai-codex/gpt-5.6-sol:medium", { tokensPerSecond: 35, samples: 3000 }],
	]);
	const tiers = {
		class: {
			1: ["claude-bridge/claude-sonnet-5:medium", "openai-codex/gpt-5.6-luna:high"],
			2: ["openai-codex/gpt-5.6-sol:medium", "openai-codex/gpt-5.6-luna:high"],
			3: ["claude-bridge/claude-opus-5:medium"],
		},
		review: { 1: ["claude-bridge/claude-opus-5:high"], 2: ["claude-bridge/claude-opus-5:xhigh"] },
	};
	const { tiers: next, changed } = reorderByThroughput(tiers, measured);

	assert.deepEqual(next.class[1], ["claude-bridge/claude-sonnet-5:medium", "openai-codex/gpt-5.6-luna:high"], "unmeasured stays first");
	assert.deepEqual(next.class[2], ["openai-codex/gpt-5.6-luna:high", "openai-codex/gpt-5.6-sol:medium"], "faster measured leads");
	assert.deepEqual(changed, ["class 2"]);
});
