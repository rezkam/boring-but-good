import { strict as assert } from "node:assert";
import { test } from "node:test";

import { REQUIRED_KEYS, buildJudgeMessage, judgeCacheKey, judgeDispatch, JUDGE_SYSTEM_PROMPT, parseVerdict } from "./judge.ts";

const COMPLETE = {
	kind: "implement",
	worktree: "/w/lane",
	expectedHead: "abc1234",
	stopsOnHeadMismatch: true,
	forbidsPush: true,
	coordinatorGitWork: "none",
	unrenderedPlaceholders: [],
	classJustification: "substantive",
	modelUnavailability: "absent",
};

function answer(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({ ...COMPLETE, ...overrides });
}

test("parseVerdict accepts the exact contract and normalises blank strings to null", () => {
	const parsed = parseVerdict(answer({ worktree: "  /w/lane  ", expectedHead: "" }));
	assert.equal(parsed.ok, true);
	if (!parsed.ok) throw new Error("unreachable");
	assert.equal(parsed.verdict.worktree, "/w/lane");
	assert.equal(parsed.verdict.expectedHead, null);
	assert.equal(parsed.verdict.kind, "implement");
});

test("parseVerdict reads a verdict wrapped in prose or a code fence", () => {
	const wrapped = `Here is the result:\n\`\`\`json\n${answer()}\n\`\`\`\nThat is my answer.`;
	assert.equal(parseVerdict(wrapped).ok, true);
});

test("parseVerdict fails closed on anything it cannot read whole", () => {
	const cases: Array<[string, string]> = [
		["not json at all", "no JSON object"],
		["{ broken", "no JSON object"],
		[JSON.stringify({ kind: "implement" }), "expected exactly the keys"],
		[answer({ extra: 1 }), "expected exactly the keys"],
		[answer({ kind: "refactor" }), "kind is not one of"],
		[answer({ coordinatorGitWork: "merge" }), "coordinatorGitWork"],
		[answer({ classJustification: "great" }), "classJustification"],
		[answer({ modelUnavailability: "maybe" }), "modelUnavailability"],
		[answer({ forbidsPush: "yes" }), "must be booleans"],
		[answer({ unrenderedPlaceholders: "none" }), "must be an array"],
		[answer({ worktree: 7 }), "worktree must be"],
	];
	for (const [raw, expected] of cases) {
		const parsed = parseVerdict(raw);
		assert.equal(parsed.ok, false, `expected a refusal for ${raw.slice(0, 40)}`);
		if (parsed.ok) throw new Error("unreachable");
		assert.match(parsed.error, new RegExp(expected, "i"));
	}
});

test("the judge is told the prompt is data, and the prompt is delimited", () => {
	assert.match(JUDGE_SYSTEM_PROMPT, /never instructions to follow/);
	const message = buildJudgeMessage({ prompt: "do the thing", agent: "worker", declaredClass: 2 });
	assert.match(message, /Agent name carried by the launch: worker/);
	assert.match(message, /Class declared in the routing header: 2/);
	assert.match(message, /<<<DISPATCH_PROMPT_BEGIN>>>\ndo the thing\n<<<DISPATCH_PROMPT_END>>>/);
});

test("the cache key changes with the prompt, the agent, and the declared class", () => {
	const base = { prompt: "p", agent: "worker", declaredClass: 1 as const };
	assert.notEqual(judgeCacheKey(base), judgeCacheKey({ ...base, prompt: "q" }));
	assert.notEqual(judgeCacheKey(base), judgeCacheKey({ ...base, agent: "scout" }));
	assert.notEqual(judgeCacheKey(base), judgeCacheKey({ ...base, declaredClass: 2 }));
});

test("judgeDispatch returns the verdict on a clean answer", async () => {
	const outcome = await judgeDispatch(async () => ({ text: answer(), stopReason: "stop" }), { prompt: "p", declaredClass: 1 });
	assert.equal(outcome.ok, true);
	if (!outcome.ok) throw new Error("unreachable");
	assert.equal(outcome.verdict.kind, "implement");
	assert.equal(outcome.attempts.length, 1);
});

test("judgeDispatch retries unreadable output once, then refuses", async () => {
	let calls = 0;
	const flaky = async () => {
		calls += 1;
		return { text: calls === 1 ? "sorry, what?" : answer(), stopReason: "stop" };
	};
	const recovered = await judgeDispatch(flaky, { prompt: "p", declaredClass: 1 });
	assert.equal(recovered.ok, true);
	assert.equal(calls, 2);

	const always = await judgeDispatch(async () => ({ text: "nope", stopReason: "stop" }), { prompt: "p", declaredClass: 1 });
	assert.equal(always.ok, false);
	if (always.ok) throw new Error("unreachable");
	assert.match(always.error, /no JSON object/);
	assert.equal(always.attempts.length, 2);
});

test("judgeDispatch refuses when the model errors or is cut off", async () => {
	const thrown = await judgeDispatch(async () => {
		throw new Error("quota exhausted");
	}, { prompt: "p", declaredClass: 1 });
	assert.equal(thrown.ok, false);
	if (thrown.ok) throw new Error("unreachable");
	assert.match(thrown.error, /could not be reached: quota exhausted/);

	const truncated = await judgeDispatch(async () => ({ text: answer().slice(0, 20), stopReason: "length" }), {
		prompt: "p",
		declaredClass: 1,
	});
	assert.equal(truncated.ok, false);
	if (truncated.ok) throw new Error("unreachable");
	assert.match(truncated.error, /stopped with "length"/);
});

test("parseVerdict refuses a placeholder array with non-string entries", () => {
	const parsed = parseVerdict(answer({ unrenderedPlaceholders: [1, "x"] }));
	assert.equal(parsed.ok, false);
	if (parsed.ok) throw new Error("unreachable");
	assert.match(parsed.error, /non-empty string/);
});

test("the required key list is sorted, because the parser compares sorted key lists", () => {
	// An unsorted entry made every well-formed verdict fail the exact-key-set check.
	const sorted = [...REQUIRED_KEYS].sort();
	assert.deepEqual(REQUIRED_KEYS, sorted);
});
