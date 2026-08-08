import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { PromptVerdict } from "./judge.ts";
import {
	checkWriterCap,
	contractPrompt,
	continuationPrompt,
	DEFAULT_CONFIG,
	evaluateStructure,
	evaluateVerdicts,
	laneSummary,
	modelClass,
	newCampaign,
	openReview,
	parseModelPin,
	parseRouteHeader,
	parseScriptChildren,
	readStatusBlock,
	type Campaign,
	type GuardRequest,
	type JudgeTarget,
} from "./policy.ts";

const WORKTREE = "/Users/dev/.agents/worktrees/demo-20260101";
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const GOOD_ROUTE = "ROUTE: s1-parser | class 1 | openai-codex/gpt-5.6-luna:high | mechanical single-file transcription";

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
		`Implement slice S1 in ${WORKTREE} at exact HEAD ${HEAD}. Stop and report if HEAD differs.`,
		"Commit locally on your branch and never push, never run gh, never open a PR.",
	].join("\n");
}

function request(overrides: Partial<GuardRequest> = {}): GuardRequest {
	const base: GuardRequest = {
		tool: "subagent",
		input: {},
		now: 1_000,
		armed: true,
		campaign: campaign(),
		config: DEFAULT_CONFIG,
		...overrides,
	};
	const isLaunch = base.input.agent !== undefined || base.input.workflowScript !== undefined;
	if (isLaunch && base.input.async === undefined && base.input.action === undefined) {
		base.input = { ...base.input, async: true };
	}
	return base;
}

/** A verdict for a compliant writer dispatch; tests override the field under test. */
function verdict(overrides: Partial<PromptVerdict> = {}): PromptVerdict {
	return {
		kind: "implement",
		worktree: WORKTREE,
		expectedHead: HEAD,
		stopsOnHeadMismatch: true,
		forbidsPush: true,
		coordinatorGitWork: "none",
		unrenderedPlaceholders: [],
		classJustification: "substantive",
		...overrides,
	};
}

function structure(req: GuardRequest): { code: string; reason: string } {
	const decision = evaluateStructure(req);
	assert.equal(decision.allow, false, `expected a structural denial, got: ${JSON.stringify(decision)}`);
	if (decision.allow) throw new Error("unreachable");
	return { code: decision.code, reason: decision.reason };
}

function targets(req: GuardRequest): JudgeTarget[] {
	const decision = evaluateStructure(req);
	assert.equal(decision.allow, true, `expected structure to pass, got: ${JSON.stringify(decision)}`);
	if (!decision.allow) throw new Error("unreachable");
	return decision.judge;
}

/** Run both phases with one verdict per judged prompt. */
function judged(req: GuardRequest, verdicts: PromptVerdict[]): { allow: boolean; code?: string; reason?: string } {
	const list = targets(req);
	assert.equal(list.length, verdicts.length, "test supplied the wrong number of verdicts");
	const decision = evaluateVerdicts(
		req,
		list.map((target, index) => ({ target, verdict: verdicts[index] })),
	);
	return decision.allow ? { allow: true } : { allow: false, code: decision.code, reason: decision.reason };
}

function denyJudged(req: GuardRequest, verdicts: PromptVerdict[]): { code: string; reason: string } {
	const result = judged(req, verdicts);
	assert.equal(result.allow, false, "expected a denial from the judged phase");
	return { code: result.code!, reason: result.reason! };
}

function launch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { agent: "worker", model: "openai-codex/gpt-5.6-luna:high", task: implementTask(GOOD_ROUTE), ...overrides };
}

// ── structural rules, decided without a model call ──────────────────────────────

test("parseModelPin requires a provider-qualified id and a known effort suffix", () => {
	assert.deepEqual(parseModelPin("openai-codex/gpt-5.6-luna:high"), { id: "openai-codex/gpt-5.6-luna", effort: "high" });
	assert.equal(parseModelPin("gpt-5.6-sol"), null);
	assert.equal(parseModelPin("gpt-5.6-sol:turbo"), null);
	assert.equal(parseModelPin(""), null);
});

test("modelClass reads the tier table as model-and-effort pairs", () => {
	assert.equal(modelClass("openai-codex/gpt-5.6-luna", "high"), 1);
	assert.equal(modelClass("claude-bridge/claude-sonnet-5", "medium"), 1);
	assert.equal(modelClass("openai-codex/gpt-5.6-terra", "medium"), 2);
	assert.equal(modelClass("openai-codex/gpt-5.6-sol", "medium"), 3);
	assert.equal(modelClass("claude-bridge/claude-opus-5", "low"), 2);
	assert.equal(modelClass("claude-bridge/claude-opus-5", "medium"), 3);
	assert.equal(modelClass("openai-codex/gpt-5.6-luna", "off"), null);
	assert.equal(modelClass("some/unknown-model", "high"), null);
});

test("parseRouteHeader reads the four declared fields", () => {
	assert.deepEqual(parseRouteHeader(GOOD_ROUTE), {
		key: "s1-parser",
		cls: 1,
		model: "openai-codex/gpt-5.6-luna:high",
		reason: "mechanical single-file transcription",
	});
	assert.equal(parseRouteHeader("no header here"), null);
});

test("readStatusBlock reads the block, not the prose around it", () => {
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

	const chatty = ["I checked the PR and the AGENTS file and the DIRECT dependencies.", "", "CAMPAIGN demo", "NEXT integrate"].join("\n");
	const result = readStatusBlock(chatty);
	assert.equal(result.ok, false);
	assert.ok(result.missing.includes("PR"));
});

test("the guard is inert when no campaign is registered and the skill is not loaded", () => {
	assert.deepEqual(evaluateStructure(request({ armed: false, campaign: null, input: launch() })), { allow: true, judge: [] });
});

test("CG001: once the coordinator skill is loaded, a launch without a registered campaign fails", () => {
	const { code, reason } = structure(request({ campaign: null, input: launch() }));
	assert.equal(code, "CG001");
	assert.match(reason, /coordinator_campaign/);
});

test("a closed campaign returns the guard to inert, and re-arming asks for a new campaign", () => {
	const closed = campaign({ status: "closed" });
	assert.deepEqual(evaluateStructure(request({ armed: false, campaign: closed, input: launch() })), { allow: true, judge: [] });
	assert.equal(structure(request({ armed: true, campaign: closed, input: launch() })).code, "CG001");
});

test("CG002: a launch with no model, or a model without an effort suffix, fails", () => {
	assert.equal(structure(request({ input: launch({ model: undefined }) })).code, "CG002");
	assert.equal(structure(request({ input: launch({ model: "gpt-5.6-sol" }) })).code, "CG002");
	assert.equal(structure(request({ input: launch({ model: "openai-codex/gpt-5.6-luna", thinking: "high" }) })).code, "CG002");
});

test("CG003: a pinned launch with no ROUTE header fails", () => {
	const { code, reason } = structure(request({ input: launch({ task: `Implement slice S1 in ${WORKTREE}.` }) }));
	assert.equal(code, "CG003");
	assert.match(reason, /ROUTE:/);
});

test("CG004: the header must name the launched model, and the class the tier table gives it", () => {
	assert.equal(structure(request({ input: launch({ model: "openai-codex/gpt-5.6-sol:high" }) })).code, "CG004");

	const mislabelled = "ROUTE: s1 | class 1 | openai-codex/gpt-5.6-sol:medium | claims to be mechanical";
	assert.equal(
		structure(request({ input: launch({ model: "openai-codex/gpt-5.6-sol:medium", task: implementTask(mislabelled) }) })).code,
		"CG004",
	);

	const lazyEffort = "ROUTE: s1 | class 1 | openai-codex/gpt-5.6-luna:off | mechanical change";
	const { code, reason } = structure(
		request({ input: launch({ model: "openai-codex/gpt-5.6-luna:off", task: implementTask(lazyEffort) }) }),
	);
	assert.equal(code, "CG004");
	assert.match(reason, /high/);
});

test("CG005: hard turn and tool budgets are refused, in arguments or inside a script", () => {
	assert.equal(structure(request({ input: launch({ turnBudget: { maxTurns: 40 } }) })).code, "CG005");
	assert.equal(structure(request({ input: launch({ toolBudget: { soft: 60, hard: 90 } }) })).code, "CG005");
	assert.equal(targets(request({ input: launch({ usageBudget: { tokens: { soft: 200_000 } } }) })).length, 1);

	const script = `const r = await runs.run('s1', {agent:'worker', model:'openai-codex/gpt-5.6-luna:high', maxTurns: 30, task: 'x'}); return r`;
	assert.equal(structure(request({ input: { workflowScript: script, async: true } })).code, "CG005");
});

test("CG007: the harness commit agent is never dispatched", () => {
	assert.equal(structure(request({ input: launch({ agent: "commit" }) })).code, "CG007");
});

test("CG008: launches are refused while the status block is stale, management actions are not", () => {
	const stale = { ...request(), now: 1_000 + 6 * 60_000 };
	const { code, reason } = structure({ ...stale, input: launch({ async: true }) });
	assert.equal(code, "CG008");
	assert.match(reason, /status block/i);

	assert.deepEqual(evaluateStructure({ ...stale, input: { action: "status" } }), { allow: true, judge: [] });
	assert.deepEqual(evaluateStructure({ ...stale, input: { action: "stop", runId: "abc" } }), { allow: true, judge: [] });
});

test("CG010: a route key cannot be reused while its lane is still open", () => {
	const busy = campaign({
		lanes: [{ key: "s1-parser", kind: "implement", model: "m:high", startedAt: 1, state: "returned", note: "returned commit ab12cd34" }],
	});
	const { code, reason } = structure(request({ campaign: busy, input: launch() }));
	assert.equal(code, "CG010");
	assert.match(reason, /You already dispatched s1-parser/, "must lead with the fact that the work happened");
	assert.match(reason, /returned commit ab12cd34/, "must replay what came back, so the retry is obviously redundant");
	assert.match(reason, /action "integrated"/, "must name the call that unblocks the next dispatch");
});

test("CG011: corrections are capped, counted by id, runId or dir, and resume counts too", () => {
	const steered = campaign({ steers: { run7: 2 } });
	assert.equal(structure(request({ campaign: steered, input: { action: "steer", runId: "run7" } })).code, "CG011");
	assert.equal(structure(request({ campaign: steered, input: { action: "steer", id: "run7", task: "again" } })).code, "CG011");
	assert.equal(structure(request({ campaign: steered, input: { action: "resume", id: "run7" } })).code, "CG011");
	assert.equal(structure(request({ campaign: campaign({ steers: { "/w/lane": 2 } }), input: { action: "steer", dir: "/w/lane" } })).code, "CG011");

	assert.deepEqual(evaluateStructure(request({ campaign: campaign({ steers: { run7: 1 } }), input: { action: "steer", id: "run7" } })), {
		allow: true,
		judge: [],
	});
});

test("CG014: spawning an agent through bash bypasses the guard and is refused", () => {
	assert.equal(structure(request({ tool: "bash", input: { command: "codex exec 'implement slice 4'" } })).code, "CG014");
	assert.equal(structure(request({ tool: "bash", input: { command: "pi -p 'go build the thing'" } })).code, "CG014");
	assert.deepEqual(evaluateStructure(request({ tool: "bash", input: { command: "npm test -- --run" } })), { allow: true, judge: [] });
});

test("CG015: destructive git is refused, including behind global options and force refspecs", () => {
	for (const command of [
		"git reset --hard origin/main",
		"git stash",
		"git checkout -- src/app.ts",
		"git push --force origin main",
		"git push --force-with-lease origin main",
		"git push origin +HEAD:main",
		"git push origin +main",
		`git -C ${WORKTREE} reset --hard origin/main`,
		"git -c core.pager=cat stash",
		"git worktree remove -f /w/lane",
	]) {
		assert.equal(structure(request({ tool: "bash", input: { command } })).code, "CG015", `expected ${command} to be refused`);
	}
	for (const command of ["git push origin HEAD", "git push origin HEAD:main", "git switch -C feat/x abc1234"]) {
		assert.deepEqual(evaluateStructure(request({ tool: "bash", input: { command } })), { allow: true, judge: [] }, command);
	}
});

test("CG016: unclassifiable actions and scheduled work are refused", () => {
	const { code, reason } = structure(request({ input: { action: "schedule.create", agent: "worker", task: "later", every: "1h" } }));
	assert.equal(code, "CG016");
	assert.match(reason, /scheduler/);
	assert.equal(structure(request({ input: { action: "schedule.run", scheduleName: "nightly" } })).code, "CG016");
	assert.deepEqual(evaluateStructure(request({ input: { action: "get", agent: "worker" } })), { allow: true, judge: [] });
});

test("CG017: a launch must say whether it runs in the foreground", () => {
	const { code, reason } = structure({ ...request(), input: launch() });
	assert.equal(code, "CG017");
	assert.match(reason, /async/);
});

// ── workflow scripts ────────────────────────────────────────────────────────────

test("parseScriptChildren keeps each child's fields together, quoted or not", () => {
	const script = `runs.all([{key:'a', agent:'scout', model:'m:high', task: \`ROUTE: a | class 1 | m:high | why\`}, {"key":"b","agent":"worker","model":"n:high","task":"t"}])`;
	const { children, agentKeys } = parseScriptChildren(script);
	assert.equal(agentKeys, 2);
	assert.deepEqual(
		children.map((child) => [child.agent, child.model]),
		[
			["scout", "m:high"],
			["worker", "n:high"],
		],
	);
});

test("CG002: a script whose child fields are not literals cannot be verified", () => {
	const shorthand = `const agent = 'scout'; const model = otherModel; return runs.run('x', {agent, model, task})`;
	const { code, reason } = structure(request({ input: { workflowScript: shorthand, async: true } }));
	assert.equal(code, "CG002");
	assert.match(reason, /literal/i);
});

test("every child of a script needs its own pinned model and routing header", () => {
	const header = (key: string) => `ROUTE: ${key} | class 1 | openai-codex/gpt-5.6-luna:high | read-only inventory`;
	const noModel = `runs.all([{key:'a', agent:'scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${header("a")}\`}, {key:'b', agent:'scout', task: \`${header("b")}\`}])`;
	assert.match(structure(request({ input: { workflowScript: noModel, async: true } })).reason, /no literal model/);

	const noRoute = `runs.all([{key:'a', agent:'scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${header("a")}\`}, {key:'b', agent:'scout', model:'openai-codex/gpt-5.6-luna:high', task: 'just do it'}])`;
	assert.equal(structure(request({ input: { workflowScript: noRoute, async: true } })).code, "CG003");
});

test("CG004: a child's header must name the model that child launches with", () => {
	const good = `ROUTE: a | class 1 | openai-codex/gpt-5.6-luna:high | read-only inventory`;
	const wrong = `ROUTE: b | class 1 | claude-bridge/claude-sonnet-5:medium | read-only inventory`;
	const script = `runs.all([{key:'a', agent:'scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${good}\`}, {key:'b', agent:'scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${wrong}\`}])`;
	const { code, reason } = structure(request({ input: { workflowScript: script, async: true } }));
	assert.equal(code, "CG004");
	assert.match(reason, /declares/i);
});

test("CG010: two children of one script cannot share a route key", () => {
	const header = `ROUTE: same | class 1 | openai-codex/gpt-5.6-luna:high | read-only inventory`;
	const script = `runs.all([{key:'a', agent:'scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${header}\`}, {key:'b', agent:'scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${header}\`}])`;
	assert.equal(structure(request({ input: { workflowScript: script, async: true } })).code, "CG010");
});

// ── judged rules, decided from the verdict ──────────────────────────────────────

test("a compliant writer dispatch passes both phases", () => {
	assert.deepEqual(judged(request({ input: launch() }), [verdict()]), { allow: true });
});

test("CG006: a review before the review phase is refused however the prompt is labelled", () => {
	const { code, reason } = denyJudged(request({ input: launch() }), [verdict({ kind: "review", stopsOnHeadMismatch: false })]);
	assert.equal(code, "CG006");
	assert.match(reason, /0 of 4/);

	const reviewing = campaign({ status: "review", slicesDone: 4 });
	assert.deepEqual(judged(request({ campaign: reviewing, input: launch() }), [verdict({ kind: "review", stopsOnHeadMismatch: false })]), {
		allow: true,
	});
});

test("CG006: only one reviewer runs at a time", () => {
	const busy = campaign({
		status: "review",
		slicesDone: 4,
		lanes: [{ key: "r1", kind: "review", model: "m:high", startedAt: 1, state: "running" }],
	});
	assert.equal(denyJudged(request({ campaign: busy, input: launch() }), [verdict({ kind: "review" })]).code, "CG006");
});

test("CG007: branch-moving git work is refused even beside real implementation", () => {
	for (const work of ["rebase", "cherry-pick", "push", "pr"] as const) {
		const { code } = denyJudged(request({ input: launch() }), [verdict({ coordinatorGitWork: work })]);
		assert.equal(code, "CG007", `expected ${work} to be refused`);
	}
});

test("CG009: the prompt's boundaries are enforced from what it actually says", () => {
	assert.equal(denyJudged(request({ input: launch() }), [verdict({ worktree: null })]).code, "CG009");
	assert.equal(denyJudged(request({ input: launch() }), [verdict({ expectedHead: null })]).code, "CG009");
	assert.equal(denyJudged(request({ input: launch() }), [verdict({ stopsOnHeadMismatch: false })]).code, "CG009");
	assert.equal(denyJudged(request({ input: launch() }), [verdict({ forbidsPush: false })]).code, "CG009");

	const { code, reason } = denyJudged(request({ input: launch() }), [verdict({ worktree: "/Users/dev/some-other-checkout" })]);
	assert.equal(code, "CG009");
	assert.match(reason, /demo-20260101/);

	assert.deepEqual(judged(request({ input: launch() }), [verdict({ worktree: `${WORKTREE.slice(0, WORKTREE.lastIndexOf("/"))}/demo-lane-a` })]), {
		allow: true,
	});
});

test("CG009: an investigation needs no HEAD, a writer does", () => {
	assert.deepEqual(judged(request({ input: launch() }), [verdict({ kind: "investigate", expectedHead: null, stopsOnHeadMismatch: false })]), {
		allow: true,
	});
});

test("CG009: unrendered placeholders the judge found are refused", () => {
	const { code, reason } = denyJudged(request({ input: launch() }), [verdict({ unrenderedPlaceholders: ["undefined/packages/app"] })]);
	assert.equal(code, "CG009");
	assert.match(reason, /undefined\/packages\/app/);
});

test("CG012: class 3 implementation needs a justification, not a label", () => {
	const route = "ROUTE: s1 | class 3 | openai-codex/gpt-5.6-sol:medium | hard";
	const req = request({ input: launch({ model: "openai-codex/gpt-5.6-sol:medium", task: implementTask(route) }) });
	assert.equal(denyJudged(req, [verdict({ classJustification: "label" })]).code, "CG012");
	assert.deepEqual(judged(req, [verdict({ classJustification: "substantive" })]), { allow: true });
});

test("CG013: an ephemeral worktree is refused", () => {
	assert.equal(denyJudged(request({ input: launch() }), [verdict({ worktree: "/tmp/scratch" })]).code, "CG013");
});

test("CG010: the writer cap counts open lanes plus the ones this call would open", () => {
	const lanes = [
		{ key: "s1", kind: "implement" as const, model: "m:high", startedAt: 1, state: "running" as const },
		{ key: "s2", kind: "implement" as const, model: "m:high", startedAt: 1, state: "returned" as const },
		{ key: "s3", kind: "implement" as const, model: "m:high", startedAt: 1, state: "running" as const },
	];
	const { code, reason } = denyJudged(request({ campaign: campaign({ lanes }), input: launch() }), [verdict()]);
	assert.equal(code, "CG010");
	assert.match(reason, /s2/);

	const integrated = lanes.map((lane) => (lane.key === "s2" ? { ...lane, state: "integrated" as const } : lane));
	assert.deepEqual(judged(request({ campaign: campaign({ lanes: integrated }), input: launch() }), [verdict()]), { allow: true });
});

test("CG010: read-only lanes do not consume writer capacity", () => {
	const lanes = [
		{ key: "s1", kind: "implement" as const, model: "m:high", startedAt: 1, state: "running" as const },
		{ key: "s2", kind: "implement" as const, model: "m:high", startedAt: 1, state: "running" as const },
		{ key: "s3", kind: "implement" as const, model: "m:high", startedAt: 1, state: "running" as const },
	];
	assert.deepEqual(
		judged(request({ campaign: campaign({ lanes }), input: launch() }), [verdict({ kind: "investigate", expectedHead: null, stopsOnHeadMismatch: false })]),
		{ allow: true },
	);
});

test("a script may carry investigations, but never writers or reviewers", () => {
	const header = (key: string) => `ROUTE: ${key} | class 1 | openai-codex/gpt-5.6-luna:high | read-only inventory`;
	const script = `runs.all([{key:'a', agent:'scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${header("a")}\`}, {key:'b', agent:'scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${header("b")}\`}])`;
	const req = request({ input: { workflowScript: script, async: true } });
	const readOnly = verdict({ kind: "investigate", expectedHead: null, stopsOnHeadMismatch: false });

	assert.deepEqual(judged(req, [readOnly, readOnly]), { allow: true });

	const { code, reason } = denyJudged(req, [readOnly, verdict()]);
	assert.equal(code, "CG010");
	assert.match(reason, /one at a time/);

	assert.equal(denyJudged(req, [readOnly, verdict({ kind: "review" })]).code, "CG006");
});

// ── campaign lifecycle and prompts ──────────────────────────────────────────────

test("openReview refuses while slices remain or lanes are unintegrated", () => {
	assert.equal(openReview(campaign({ slicesDone: 3 })).ok, false);
	const unintegrated = openReview(
		campaign({ slicesDone: 4, lanes: [{ key: "s4", kind: "implement", model: "m:high", startedAt: 1, state: "returned" }] }),
	);
	assert.equal(unintegrated.ok, false);
	assert.deepEqual(
		openReview(campaign({ slicesDone: 4, lanes: [{ key: "s4", kind: "implement", model: "m:high", startedAt: 1, state: "integrated" }] })),
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

test("the injected contract carries the live campaign state, and nothing once closed", () => {
	const text = contractPrompt(
		campaign({ slicesDone: 2, lanes: [{ key: "s3", kind: "implement", model: "m:high", startedAt: 1, state: "running" }] }),
		true,
		1_000,
	);
	assert.match(text, /2 done of 4/);
	assert.match(text, /s3 \(implement/);
	assert.match(text, /ROUTE: <key> \| class <1\|2\|3>/);
	assert.match(text, /Agents are in flight/);

	assert.equal(contractPrompt(null, false, 1_000), "");
	assert.equal(contractPrompt(campaign({ status: "closed" }), false, 1_000), "");
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

test("agent keys inside prompt text are not counted as children", () => {
	const task = "ROUTE: a | class 1 | openai-codex/gpt-5.6-luna:high | read-only inventory. The assigned agent: scout should read only. Never push.";
	const script = `runs.all([{key:'a', agent:'scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${task}\`}])`;
	const { children, agentKeys } = parseScriptChildren(script);
	assert.equal(agentKeys, 1);
	assert.equal(children.length, 1);
});

test("batch and chain inputs are treated as launches rather than slipping past", () => {
	assert.equal(structure(request({ input: { tasks: [{ agent: "worker", task: "x" }] } })).code, "CG017");
	assert.equal(structure(request({ input: { chain: "legacy", async: true } })).code, "CG002");
});

test("the writer cap is one rule, so the judge-off path enforces it too", () => {
	const lanes = [
		{ key: "s1", kind: "implement" as const, model: "m:high", startedAt: 1, state: "running" as const },
		{ key: "s2", kind: "implement" as const, model: "m:high", startedAt: 1, state: "returned" as const },
		{ key: "s3", kind: "implement" as const, model: "m:high", startedAt: 1, state: "running" as const },
	];
	const full = campaign({ lanes });
	assert.equal(checkWriterCap(full, 1).allow, false);
	assert.equal(checkWriterCap(full, 0).allow, true);
	assert.equal(checkWriterCap(campaign(), 3).allow, true);
	assert.equal(checkWriterCap(campaign(), 4).allow, false);
});

test("every structural problem with a launch is reported in one refusal", () => {
	// A bare model and no routing header: both are wrong, and one retry should fix both.
	const { code, reason } = structure(
		request({ input: { agent: "worker", model: "gpt-5.6-luna", task: "Implement slice S1.", async: true } }),
	);
	assert.equal(code, "CG002");
	assert.match(reason, /2 problems/);
	assert.match(reason, /\[CG002\]/);
	assert.match(reason, /\[CG003\]/);
});

test("every missing prompt boundary is reported in one refusal", () => {
	const { reason } = denyJudged(request({ input: launch() }), [
		verdict({ worktree: null, expectedHead: null, stopsOnHeadMismatch: false, forbidsPush: false }),
	]);
	assert.match(reason, /4 problems/);
	assert.match(reason, /worktree path/);
	assert.match(reason, /expected HEAD sha/);
	assert.match(reason, /stop and report/);
	assert.match(reason, /never pushes/);
});

test("a shape refusal teaches the rules the agent has not been shown yet", () => {
	// Refused on structure, so the prompt was never read: the boundary rules still have to
	// arrive now, or the retry gets refused for something it was never told.
	const { reason } = structure(request({ input: { agent: "worker", model: "gpt-5.6-luna", task: "Do slice one.", async: true } }));
	assert.match(reason, /exact HEAD/, "must state the HEAD requirement");
	assert.match(reason, /Never push/, "must state the push prohibition");
	assert.match(reason, /turnBudget/, "must state the budget prohibition");
	assert.match(reason, /open-review/, "must state when review is allowed");
	assert.match(reason, new RegExp(WORKTREE), "must name the campaign worktree");
});

test("state refusals stay short, because the contract is not the fix", () => {
	const stale = structure({ ...request(), now: 1_000 + 20 * 60_000, input: launch({ async: true }) });
	assert.equal(stale.code, "CG008");
	assert.doesNotMatch(stale.reason, /turnBudget/, "a stale status block is fixed by printing one, not by rewriting the dispatch");
});

test("a writer hidden in a script is told which call to make instead", () => {
	const header = "ROUTE: s1 | class 1 | openai-codex/gpt-5.6-luna:high | mechanical edit";
	const script = `runs.run('s1', {agent:'worker', model:'openai-codex/gpt-5.6-luna:high', task: \`${header}\`})`;
	const { code, reason } = denyJudged(request({ input: { workflowScript: script, async: true } }), [verdict()]);
	assert.equal(code, "CG010");
	assert.match(reason, /one direct subagent call/, "must name the call that works");
	assert.match(reason, /integrated/, "must say what unblocks the next writer");
	assert.match(reason, /ROUTE:/, "must carry the contract, since the fix is a rewritten dispatch");
});

test("an unroutable model refusal names every model that would work", () => {
	const task = implementTask("ROUTE: s1-parser | class 1 | openai-codex/gpt-9-nova:high | mechanical edit");
	const { code, reason } = structure(request({ input: launch({ model: "openai-codex/gpt-9-nova:high", task }) }));
	assert.equal(code, "CG004");
	for (const listed of ["gpt-5.6-luna:high", "claude-sonnet:medium", "gpt-5.6-terra:medium", "claude-opus:low", "gpt-5.6-sol:medium", "claude-fable:high"]) {
		assert.match(reason, new RegExp(listed.replace(/[.]/g, "\\.")), `must list ${listed}`);
	}
});
