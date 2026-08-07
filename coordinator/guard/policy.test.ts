import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	continuationPrompt,
	contractPrompt,
	DEFAULT_CONFIG,
	evaluate,
	laneSummary,
	modelClass,
	newCampaign,
	openReview,
	parseModelPin,
	parseRouteHeader,
	readStatusBlock,
	type Campaign,
	type GuardRequest,
} from "./policy.ts";

const WORKTREE = "/Users/dev/.agents/worktrees/demo-20260101";
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function campaign(overrides: Partial<Campaign> = {}): Campaign {
	return {
		...newCampaign({
			slug: "demo",
			worktree: WORKTREE,
			planPath: `${WORKTREE}/plan.html`,
			slicesTotal: 4,
			authorized: "implement approved slices; commit; push; open and update the PR",
			startedAt: 1_000,
		}),
		lastStatusAt: 1_000,
		...overrides,
	};
}

function implementTask(routeLine: string): string {
	return [
		routeLine,
		`Implement slice S1 in ${WORKTREE} at exact HEAD ${HEAD}.`,
		"Commit locally on your branch and never push, never run gh, never open a PR.",
	].join("\n");
}

function request(overrides: Partial<GuardRequest> = {}): GuardRequest {
	return {
		tool: "subagent",
		input: {},
		now: 1_000,
		armed: true,
		campaign: campaign(),
		config: DEFAULT_CONFIG,
		...overrides,
	};
}

function deny(req: GuardRequest): { code: string; reason: string } {
	const decision = evaluate(req);
	assert.equal(decision.allow, false, `expected a denial, got: ${JSON.stringify(decision)}`);
	if (decision.allow) throw new Error("unreachable");
	return { code: decision.code, reason: decision.reason };
}

function allow(req: GuardRequest): void {
	const decision = evaluate(req);
	assert.equal(decision.allow, true, `expected allow, got: ${JSON.stringify(decision)}`);
}

const GOOD_ROUTE = "ROUTE: s1-parser | class 1 | openai-codex/gpt-5.6-luna:high | mechanical single-file transcription";

test("parseModelPin requires a provider-qualified id and a known effort suffix", () => {
	assert.deepEqual(parseModelPin("openai-codex/gpt-5.6-luna:high"), { id: "openai-codex/gpt-5.6-luna", effort: "high" });
	assert.equal(parseModelPin("gpt-5.6-sol"), null);
	assert.equal(parseModelPin("gpt-5.6-sol:turbo"), null);
	assert.equal(parseModelPin(""), null);
});

test("modelClass maps the tier table, and reads effort where the table splits on it", () => {
	assert.equal(modelClass("openai-codex/gpt-5.6-luna", "high"), 1);
	assert.equal(modelClass("claude-bridge/claude-sonnet-5", "medium"), 1);
	assert.equal(modelClass("openai-codex/gpt-5.6-terra", "medium"), 2);
	assert.equal(modelClass("openai-codex/gpt-5.6-sol", "medium"), 3);
	assert.equal(modelClass("claude-bridge/claude-fable-5", "high"), 3);
	assert.equal(modelClass("some/unknown-model", "high"), null);

	// dispatch.md splits opus by effort: low is class 2, medium and above is class 3.
	assert.equal(modelClass("claude-bridge/claude-opus-5", "low"), 2);
	assert.equal(modelClass("claude-bridge/claude-opus-5", "medium"), 3);
});

test("CG004: an opus route is judged at the effort it was pinned at", () => {
	const asClass2 =
		"ROUTE: s1-parser | class 2 | claude-bridge/claude-opus-5:low | prose-led integration work across two packages";
	allow(request({ input: { agent: "worker", model: "claude-bridge/claude-opus-5:low", task: implementTask(asClass2) } }));

	const mislabelled =
		"ROUTE: s1-parser | class 2 | claude-bridge/claude-opus-5:medium | prose-led integration work across two packages";
	assert.equal(
		deny(request({ input: { agent: "worker", model: "claude-bridge/claude-opus-5:medium", task: implementTask(mislabelled) } })).code,
		"CG004",
	);
});

test("CG006: a review prompt is caught even when it mentions fixing, writing, or adding", () => {
	const route = "ROUTE: r1 | class 3 | openai-codex/gpt-5.6-sol:high | final whole-branch review of the campaign diff";
	const task = [
		route,
		`Conduct a read-only review of ${WORKTREE} at HEAD ${HEAD}.`,
		"Return every finding that the author would likely fix. Do not modify files, and never push.",
		"Write the findings as a list, and add a severity to each one.",
	].join("\n");
	assert.equal(deny(request({ input: { agent: "worker", model: "openai-codex/gpt-5.6-sol:high", task } })).code, "CG006");
});

test("a workflow script may carry investigations, but never writers or reviewers", () => {
	const investigation = (key: string) =>
		`ROUTE: ${key} | class 1 | openai-codex/gpt-5.6-luna:high | read-only inventory\\nRead-only inventory in ${WORKTREE} at HEAD ${HEAD}. Never push.`;
	const readOnly = `const r = await runs.all([{key:'a', agent:'scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${investigation("a")}\`}, {key:'b', agent:'scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${investigation("b")}\`}]); return r`;
	allow(request({ input: { workflowScript: readOnly } }));

	const writers = `const r = await runs.all([{key:'a', agent:'worker', model:'openai-codex/gpt-5.6-luna:high', task: \`${implementTask(GOOD_ROUTE)}\`}, {key:'b', agent:'worker', model:'openai-codex/gpt-5.6-luna:high', task: \`${implementTask(GOOD_ROUTE)}\`}]); return r`;
	const { code, reason } = deny(request({ input: { workflowScript: writers } }));
	assert.equal(code, "CG010");
	assert.match(reason, /one dispatch at a time/);
});

test("CG009: the prompt must name the campaign's worktree or one beside it", () => {
	const model = "openai-codex/gpt-5.6-luna:high";
	const sibling = "/Users/dev/.agents/worktrees/demo-lane-a";
	allow(
		request({
			input: { agent: "worker", model, task: `${GOOD_ROUTE}\nImplement slice S1 in ${sibling} at exact HEAD ${HEAD}. Never push.` },
		}),
	);

	const elsewhere = "/Users/dev/some-other-checkout";
	const { code, reason } = deny(
		request({
			input: { agent: "worker", model, task: `${GOOD_ROUTE}\nImplement slice S1 in ${elsewhere} at exact HEAD ${HEAD}. Never push.` },
		}),
	);
	assert.equal(code, "CG009");
	assert.match(reason, /demo-20260101/);

	assert.equal(
		deny(
			request({
				input: { agent: "worker", model, task: `${GOOD_ROUTE}\nImplement slice S1 with /usr/bin/env node at exact HEAD ${HEAD}. Never push.` },
			}),
		).code,
		"CG009",
	);
});

test("an action that schedules new work is judged as a launch, not as management", () => {
	const { code } = deny(request({ input: { action: "schedule.create", agent: "worker", task: "implement slice 4", every: "1h" } }));
	assert.equal(code, "CG002");

	allow(request({ input: { action: "get", agent: "worker" } }));
	allow(request({ input: { action: "list" } }));
});

test("CG011: the steer cap reads the id field the subagent API prefers", () => {
	const steered = campaign({ steers: { run7: 2 } });
	assert.equal(deny(request({ campaign: steered, input: { action: "steer", id: "run7", message: "again" } })).code, "CG011");
});

test("parseRouteHeader reads the four declared fields", () => {
	const parsed = parseRouteHeader(GOOD_ROUTE);
	assert.deepEqual(parsed, {
		key: "s1-parser",
		cls: 1,
		model: "openai-codex/gpt-5.6-luna:high",
		reason: "mechanical single-file transcription",
	});
	assert.equal(parseRouteHeader("no header here"), null);
});

test("readStatusBlock reports the fields a status block is missing", () => {
	const complete = [
		"CAMPAIGN  demo          WORKTREE /w",
		"SLICES    1 done / 4 total     NOW: S2 (running)",
		"PR        #12 MERGEABLE, checks 5/5",
		"AGENTS    worker luna@high alive",
		"DIRECT    none",
		"PARKED    none",
		"NEEDS YOU nothing",
		"NEXT      integrate lane S2",
	].join("\n");
	assert.deepEqual(readStatusBlock(complete), { ok: true, missing: [] });

	const partial = "CAMPAIGN demo\nSLICES 1 done / 4 total\nNEXT integrate";
	const result = readStatusBlock(partial);
	assert.equal(result.ok, false);
	assert.deepEqual(result.missing, ["WORKTREE", "PR", "AGENTS", "DIRECT", "PARKED", "NEEDS YOU"]);
});

test("the guard is inert when no campaign is registered and the skill is not loaded", () => {
	allow(request({ armed: false, campaign: null, input: { agent: "worker", task: "do a thing" } }));
});

test("CG001: once the coordinator skill is loaded, a launch without a registered campaign fails", () => {
	const { code, reason } = deny(request({ campaign: null, input: { agent: "worker", task: "do a thing" } }));
	assert.equal(code, "CG001");
	assert.match(reason, /coordinator_campaign/);
});

test("a closed campaign returns the guard to inert, and re-arming asks for a new campaign", () => {
	const closed = campaign({ status: "closed" });
	const launch = { agent: "worker", task: "do a thing" };
	allow(request({ armed: false, campaign: closed, input: launch }));
	allow(request({ armed: false, campaign: closed, tool: "bash", input: { command: "git stash" } }));

	const { code, reason } = deny(request({ armed: true, campaign: closed, input: launch }));
	assert.equal(code, "CG001");
	assert.match(reason, /coordinator_campaign/);
});

test("CG002: a launch with no model, or a model without an effort suffix, fails", () => {
	assert.equal(deny(request({ input: { agent: "worker", task: implementTask(GOOD_ROUTE) } })).code, "CG002");
	assert.equal(
		deny(request({ input: { agent: "worker", model: "gpt-5.6-sol", task: implementTask(GOOD_ROUTE) } })).code,
		"CG002",
	);
});

test("CG002: thinking is not a substitute for pinning effort in the model string", () => {
	const { code } = deny(
		request({ input: { agent: "worker", model: "openai-codex/gpt-5.6-luna", thinking: "high", task: implementTask(GOOD_ROUTE) } }),
	);
	assert.equal(code, "CG002");
});

test("CG003: a pinned launch with no ROUTE header fails", () => {
	const { code, reason } = deny(
		request({
			input: {
				agent: "worker",
				model: "openai-codex/gpt-5.6-luna:high",
				task: `Implement slice S1 in ${WORKTREE} at exact HEAD ${HEAD}. Never push.`,
			},
		}),
	);
	assert.equal(code, "CG003");
	assert.match(reason, /ROUTE:/);
});

test("CG004: the ROUTE header must name the model that is actually being launched", () => {
	const header = "ROUTE: s1-parser | class 1 | openai-codex/gpt-5.6-luna:high | mechanical single-file transcription";
	const { code, reason } = deny(
		request({ input: { agent: "worker", model: "openai-codex/gpt-5.6-sol:high", task: implementTask(header) } }),
	);
	assert.equal(code, "CG004");
	assert.match(reason, /gpt-5\.6-sol:high/);
});

test("CG004: the declared class must match the tier table entry for that model", () => {
	const header = "ROUTE: s1-parser | class 1 | openai-codex/gpt-5.6-sol:medium | claims to be mechanical";
	const { code } = deny(
		request({ input: { agent: "worker", model: "openai-codex/gpt-5.6-sol:medium", task: implementTask(header) } }),
	);
	assert.equal(code, "CG004");
});

test("CG012: class 3 implementation needs a written justification, not a label", () => {
	const thin = "ROUTE: s1-parser | class 3 | openai-codex/gpt-5.6-sol:medium | hard";
	assert.equal(
		deny(request({ input: { agent: "worker", model: "openai-codex/gpt-5.6-sol:medium", task: implementTask(thin) } })).code,
		"CG012",
	);

	const justified =
		"ROUTE: s1-parser | class 3 | openai-codex/gpt-5.6-sol:medium | cross-layer transport rewrite spanning six packages and the reducer contract";
	allow(request({ input: { agent: "worker", model: "openai-codex/gpt-5.6-sol:medium", task: implementTask(justified) } }));
});

test("CG005: hard turn and tool budgets are refused on every dispatch", () => {
	const base = { agent: "worker", model: "openai-codex/gpt-5.6-luna:high", task: implementTask(GOOD_ROUTE) };
	assert.equal(deny(request({ input: { ...base, turnBudget: { maxTurns: 40 } } })).code, "CG005");
	assert.equal(deny(request({ input: { ...base, toolBudget: { soft: 60, hard: 90 } } })).code, "CG005");
	allow(request({ input: { ...base, usageBudget: { tokens: { soft: 200_000 } } } }));
});

test("CG005: budgets hidden inside a workflow script are refused too", () => {
	const script = `const r = await runs.run('s1', {agent:'worker', model:'openai-codex/gpt-5.6-luna:high', maxTurns: 30, task: \`${implementTask(GOOD_ROUTE)}\`}); return r.output`;
	assert.equal(deny(request({ input: { workflowScript: script } })).code, "CG005");
});

test("CG002: every agent in a workflow script needs its own pinned model", () => {
	const script = `const r = await runs.all([{key:'a', agent:'worker', model:'openai-codex/gpt-5.6-luna:high', task: 'x'}, {key:'b', agent:'worker', task: 'y'}]); return r`;
	assert.equal(deny(request({ input: { workflowScript: script } })).code, "CG002");
});

test("CG006: reviewers cannot be dispatched before the review phase is open", () => {
	const reviewRoute =
		"ROUTE: final-review | class 3 | openai-codex/gpt-5.6-sol:high | final whole-branch review of the campaign diff";
	const input = {
		agent: "reviewer",
		model: "openai-codex/gpt-5.6-sol:high",
		task: `${reviewRoute}\nReview ${WORKTREE} at HEAD ${HEAD}. Read only, never push.`,
	};
	const { code, reason } = deny(request({ input }));
	assert.equal(code, "CG006");
	assert.match(reason, /0 of 4/);

	allow(request({ campaign: campaign({ status: "review", slicesDone: 4 }), input }));
});

test("CG006: only one reviewer runs at a time in the review phase", () => {
	const reviewRoute =
		"ROUTE: final-review-2 | class 3 | openai-codex/gpt-5.6-sol:high | second round after the first round fixes landed";
	const busy = campaign({
		status: "review",
		slicesDone: 4,
		lanes: [{ key: "final-review", kind: "review", model: "openai-codex/gpt-5.6-sol:high", startedAt: 900, state: "running" }],
	});
	const { code } = deny(
		request({
			campaign: busy,
			input: {
				agent: "reviewer",
				model: "openai-codex/gpt-5.6-sol:high",
				task: `${reviewRoute}\nReview ${WORKTREE} at HEAD ${HEAD}. Read only, never push.`,
			},
		}),
	);
	assert.equal(code, "CG006");
});

test("CG007: committing, pushing and PR work can never be dispatched", () => {
	const route = "ROUTE: commit-s1 | class 1 | openai-codex/gpt-5.6-luna:high | mechanical staging of the finished slice";
	assert.equal(
		deny(request({ input: { agent: "commit", model: "openai-codex/gpt-5.6-luna:high", task: `${route}\nIn ${WORKTREE} at ${HEAD} stage and commit. Never push.` } })).code,
		"CG007",
	);
	assert.equal(
		deny(
			request({
				input: {
					agent: "worker",
					model: "openai-codex/gpt-5.6-luna:high",
					task: `${route}\nCommit the finished work in ${WORKTREE} at ${HEAD} and open the PR. Never push.`,
				},
			}),
		).code,
		"CG007",
	);
});

test("CG008: launches are refused while the status block is stale, management actions are not", () => {
	const stale = { ...request(), now: 1_000 + 6 * 60_000 };
	const { code, reason } = deny({
		...stale,
		input: { agent: "worker", model: "openai-codex/gpt-5.6-luna:high", task: implementTask(GOOD_ROUTE) },
	});
	assert.equal(code, "CG008");
	assert.match(reason, /status block/i);

	allow({ ...stale, input: { action: "status" } });
	allow({ ...stale, input: { action: "stop", runId: "abc" } });
});

test("CG009: unrendered placeholders, and a missing worktree or HEAD, fail the prompt lint", () => {
	const model = "openai-codex/gpt-5.6-luna:high";
	assert.equal(
		deny(request({ input: { agent: "worker", model, task: `${GOOD_ROUTE}\nImplement in undefined/pkg at HEAD ${HEAD}. Never push.` } })).code,
		"CG009",
	);
	assert.equal(
		deny(request({ input: { agent: "worker", model, task: `${GOOD_ROUTE}\nImplement slice S1 at exact HEAD ${HEAD}. Never push.` } })).code,
		"CG009",
	);
	assert.equal(
		deny(request({ input: { agent: "worker", model, task: `${GOOD_ROUTE}\nImplement slice S1 in ${WORKTREE}. Never push.` } })).code,
		"CG009",
	);
	assert.equal(
		deny(request({ input: { agent: "worker", model, task: `${GOOD_ROUTE}\nImplement slice S1 in ${WORKTREE} at exact HEAD ${HEAD}.` } })).code,
		"CG009",
	);
});

test("CG013: an ephemeral worktree path is refused", () => {
	const task = [
		GOOD_ROUTE,
		`Implement slice S1 in /tmp/scratch-worktree at exact HEAD ${HEAD}.`,
		"Never push.",
	].join("\n");
	assert.equal(deny(request({ input: { agent: "worker", model: "openai-codex/gpt-5.6-luna:high", task } })).code, "CG013");
});

test("CG010: open writer lanes are capped, and lanes awaiting integration still count", () => {
	const lanes = [
		{ key: "s1", kind: "implement" as const, model: "m:high", startedAt: 900, state: "running" as const },
		{ key: "s2", kind: "implement" as const, model: "m:high", startedAt: 900, state: "returned" as const },
		{ key: "s3", kind: "implement" as const, model: "m:high", startedAt: 900, state: "running" as const },
	];
	const { code, reason } = deny(
		request({
			campaign: campaign({ lanes }),
			input: { agent: "worker", model: "openai-codex/gpt-5.6-luna:high", task: implementTask(GOOD_ROUTE) },
		}),
	);
	assert.equal(code, "CG010");
	assert.match(reason, /s2/);

	const integrated = lanes.map((lane) => (lane.key === "s2" ? { ...lane, state: "integrated" as const } : lane));
	allow(
		request({
			campaign: campaign({ lanes: integrated }),
			input: { agent: "worker", model: "openai-codex/gpt-5.6-luna:high", task: implementTask(GOOD_ROUTE) },
		}),
	);
});

test("CG010: read-only investigations do not consume writer lanes", () => {
	const lanes = [
		{ key: "s1", kind: "implement" as const, model: "m:high", startedAt: 900, state: "running" as const },
		{ key: "s2", kind: "implement" as const, model: "m:high", startedAt: 900, state: "running" as const },
		{ key: "s3", kind: "implement" as const, model: "m:high", startedAt: 900, state: "running" as const },
	];
	const route = "ROUTE: port-map | class 1 | openai-codex/gpt-5.6-luna:high | read-only inventory of the transport call sites";
	allow(
		request({
			campaign: campaign({ lanes }),
			input: {
				agent: "scout",
				model: "openai-codex/gpt-5.6-luna:high",
				task: `${route}\nRead-only inventory in ${WORKTREE} at HEAD ${HEAD}. Never push.`,
			},
		}),
	);
});

test("CG011: the same run cannot be steered indefinitely", () => {
	const steered = campaign({ steers: { run7: 2 } });
	const { code, reason } = deny(request({ campaign: steered, input: { action: "steer", runId: "run7", message: "try again" } }));
	assert.equal(code, "CG011");
	assert.match(reason, /serial milestones/);

	allow(request({ campaign: campaign({ steers: { run7: 1 } }), input: { action: "steer", runId: "run7", message: "try again" } }));
});

test("CG014: spawning an agent through bash bypasses the guard and is refused", () => {
	assert.equal(deny(request({ tool: "bash", input: { command: "codex exec 'implement slice 4'" } })).code, "CG014");
	assert.equal(deny(request({ tool: "bash", input: { command: "pi -p 'go build the thing'" } })).code, "CG014");
	allow(request({ tool: "bash", input: { command: "npm test -- --run" } }));
});

test("CG015: the destructive git commands the skill forbids are refused while a campaign is active", () => {
	assert.equal(deny(request({ tool: "bash", input: { command: "git reset --hard origin/main" } })).code, "CG015");
	assert.equal(deny(request({ tool: "bash", input: { command: "git stash" } })).code, "CG015");
	assert.equal(deny(request({ tool: "bash", input: { command: "git checkout -- src/app.ts" } })).code, "CG015");
	assert.equal(deny(request({ tool: "bash", input: { command: "git push --force origin main" } })).code, "CG015");
	assert.equal(deny(request({ tool: "bash", input: { command: "git push --force-with-lease origin main" } })).code, "CG015");
	assert.equal(
		deny(request({ tool: "bash", input: { command: "git push --force-with-lease=main:abc1234 origin main" } })).code,
		"CG015",
	);
	allow(request({ tool: "bash", input: { command: "git push origin HEAD" } }));
	allow(request({ tool: "bash", input: { command: "git switch -C feat/x abc1234" } }));
});

test("a fully compliant implementation dispatch is allowed", () => {
	allow(request({ input: { agent: "worker", model: "openai-codex/gpt-5.6-luna:high", task: implementTask(GOOD_ROUTE) } }));
});

test("CG006: a review task cannot slip through by being dispatched as a worker", () => {
	const route = "ROUTE: s1-accept | class 3 | openai-codex/gpt-5.6-sol:high | acceptance pass over the returned slice";
	const { code } = deny(
		request({
			input: {
				agent: "worker",
				model: "openai-codex/gpt-5.6-sol:high",
				task: `${route}\nConduct an independent acceptance review of commit ${HEAD} in ${WORKTREE}. Never push.`,
			},
		}),
	);
	assert.equal(code, "CG006");
});

test("openReview refuses while slices remain or lanes are unintegrated", () => {
	const midCampaign = openReview(campaign({ slicesDone: 3 }));
	assert.equal(midCampaign.ok, false);

	const unintegrated = openReview(
		campaign({
			slicesDone: 4,
			lanes: [{ key: "s4", kind: "implement", model: "m:high", startedAt: 1, state: "returned" }],
		}),
	);
	assert.equal(unintegrated.ok, false);
	if (!unintegrated.ok) assert.match(unintegrated.error, /s4/);

	assert.deepEqual(
		openReview(
			campaign({
				slicesDone: 4,
				lanes: [{ key: "s4", kind: "implement", model: "m:high", startedAt: 1, state: "integrated" }],
			}),
		),
		{ ok: true },
	);
});

test("laneSummary hides integrated lanes and reports the open ones", () => {
	assert.equal(laneSummary(campaign()), "none");
	assert.equal(
		laneSummary(
			campaign({
				lanes: [
					{ key: "s1", kind: "implement", model: "m:high", startedAt: 1, state: "integrated" },
					{ key: "s2", kind: "implement", model: "m:high", startedAt: 1, state: "running" },
				],
			}),
		),
		"s2 (implement, m:high, running)",
	);
});

test("the injected contract carries the live campaign state and the enforced rules", () => {
	const text = contractPrompt(campaign({ slicesDone: 2, lanes: [{ key: "s3", kind: "implement", model: "m:high", startedAt: 1, state: "running" }] }), true, 1_000);
	assert.match(text, /2 done of 4/);
	assert.match(text, /s3 \(implement/);
	assert.match(text, /ROUTE: <key> \| class <1\|2\|3>/);
	assert.match(text, /Agents are in flight/);

	assert.equal(contractPrompt(null, false, 1_000), "");
	assert.match(contractPrompt(null, true, 1_000), /coordinator_campaign/);
});

test("the automatic continuation names the lanes and orders liveness before new work", () => {
	const text = continuationPrompt(
		campaign({
			lanes: [
				{ key: "s1", kind: "implement", model: "m:high", startedAt: 1, state: "running" },
				{ key: "s2", kind: "implement", model: "m:high", startedAt: 1, state: "returned" },
			],
		}),
	);
	assert.match(text, /Running lanes: s1/);
	assert.match(text, /Returned, not yet integrated: s2/);
	assert.match(text, /If you are waiting, you are wrong/);
});
