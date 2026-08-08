import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { PromptVerdict } from "./judge.ts";
import {
	checkWriterCap,
	DEFAULT_TIERS,
	findTierClash,
	parseTierEntries,
	withTierList,
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
	statusBlockDisagreement,
	type Campaign,
	type GuardRequest,
	type JudgeTarget,
} from "./policy.ts";

const WORKTREE = "/Users/dev/.agents/worktrees/demo-20260101";
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
// The preferred class 1 model, so the default fixture is a compliant dispatch under CG020.
const GOOD_ROUTE = "ROUTE: s1-parser | class 1 | claude-bridge/claude-sonnet-5:medium | mechanical single-file transcription";

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

const GOOD_REVIEW_ROUTE = "ROUTE: final-review | review 2 | claude-bridge/claude-opus-5:xhigh | cross-layer branch, broad blast radius";

function reviewLaunch(overrides: Record<string, unknown> = {}) {
	return {
		agent: "campaign-reviewer",
		model: "claude-bridge/claude-opus-5:xhigh",
		async: true,
		task: implementTask(GOOD_REVIEW_ROUTE),
		...overrides,
	};
}

function assertBlock(actual: ReturnType<typeof readStatusBlock>, ok: boolean, missing: string[]): void {
	assert.equal(actual.ok, ok);
	assert.deepEqual(actual.missing, missing);
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
		modelUnavailability: "absent",
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
	return { agent: "campaign-worker", model: "claude-bridge/claude-sonnet-5:medium", task: implementTask(GOOD_ROUTE), ...overrides };
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
		axis: "class",
		cls: 1,
		model: "claude-bridge/claude-sonnet-5:medium",
		reason: "mechanical single-file transcription",
	});
	assert.equal(parseRouteHeader("no header here"), null);

	assert.deepEqual(parseRouteHeader("ROUTE: final | review 2 | claude-bridge/claude-opus-5:xhigh | cross-layer branch"), {
		key: "final",
		axis: "review",
		cls: 2,
		model: "claude-bridge/claude-opus-5:xhigh",
		reason: "cross-layer branch",
	});
	assert.equal(parseRouteHeader("ROUTE: k | review 3 | m:high | there is no third review class"), null);
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
	assertBlock(readStatusBlock(complete), true, []);

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

	const script = `const r = await runs.run('s1', {agent:'campaign-worker', model:'openai-codex/gpt-5.6-luna:high', maxTurns: 30, task: 'x'}); return r`;
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
	const script = `runs.all([{key:'a', agent:'campaign-scout', model:'m:high', task: \`ROUTE: a | class 1 | m:high | why\`}, {"key":"b","agent":"campaign-worker","model":"n:high","task":"t"}])`;
	const { children, agentKeys } = parseScriptChildren(script);
	assert.equal(agentKeys, 2);
	assert.deepEqual(
		children.map((child) => [child.agent, child.model]),
		[
			["campaign-scout", "m:high"],
			["campaign-worker", "n:high"],
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
	const noModel = `runs.all([{key:'a', agent:'campaign-scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${header("a")}\`}, {key:'b', agent:'campaign-scout', task: \`${header("b")}\`}])`;
	assert.match(structure(request({ input: { workflowScript: noModel, async: true } })).reason, /no literal model/);

	const noRoute = `runs.all([{key:'a', agent:'campaign-scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${header("a")}\`}, {key:'b', agent:'campaign-scout', model:'openai-codex/gpt-5.6-luna:high', task: 'just do it'}])`;
	assert.equal(structure(request({ input: { workflowScript: noRoute, async: true } })).code, "CG003");
});

test("CG004: a child's header must name the model that child launches with", () => {
	const good = `ROUTE: a | class 1 | openai-codex/gpt-5.6-luna:high | read-only inventory`;
	const wrong = `ROUTE: b | class 1 | claude-bridge/claude-sonnet-5:medium | read-only inventory`;
	const script = `runs.all([{key:'a', agent:'campaign-scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${good}\`}, {key:'b', agent:'campaign-scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${wrong}\`}])`;
	const { code, reason } = structure(request({ input: { workflowScript: script, async: true } }));
	assert.equal(code, "CG004");
	assert.match(reason, /declares/i);
});

test("CG010: two children of one script cannot share a route key", () => {
	const header = `ROUTE: same | class 1 | openai-codex/gpt-5.6-luna:high | read-only inventory`;
	const script = `runs.all([{key:'a', agent:'campaign-scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${header}\`}, {key:'b', agent:'campaign-scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${header}\`}])`;
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
	assert.deepEqual(
		judged(request({ campaign: reviewing, input: reviewLaunch() }), [verdict({ kind: "review", stopsOnHeadMismatch: false })]),
		{ allow: true },
	);
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
	assert.deepEqual(
		judged(request({ input: launch({ agent: "campaign-scout" }) }), [verdict({ kind: "investigate", expectedHead: null, stopsOnHeadMismatch: false })]),
		{ allow: true },
	);
});

test("CG009: unrendered placeholders the judge found are refused", () => {
	const { code, reason } = denyJudged(request({ input: launch() }), [verdict({ unrenderedPlaceholders: ["undefined/packages/app"] })]);
	assert.equal(code, "CG009");
	assert.match(reason, /undefined\/packages\/app/);
});

test("CG012: class 3 implementation needs a justification, not a label", () => {
	// The preferred class-3 model, so this isolates the justification rule from the fallback one.
	const route = "ROUTE: s1 | class 3 | claude-bridge/claude-opus-5:medium | hard";
	const req = request({ input: launch({ model: "claude-bridge/claude-opus-5:medium", task: implementTask(route) }) });
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
		judged(request({ campaign: campaign({ lanes }), input: launch({ agent: "campaign-scout" }) }), [
			verdict({ kind: "investigate", expectedHead: null, stopsOnHeadMismatch: false }),
		]),
		{ allow: true },
	);
});

test("a multi-child script carries only investigations; a single-child script is the lane vehicle", () => {
	const header = (key: string) => `ROUTE: ${key} | class 1 | claude-bridge/claude-sonnet-5:medium | read-only inventory`;
	const script = `runs.all([{key:'a', agent:'campaign-scout', model:'claude-bridge/claude-sonnet-5:medium', task: \`${header("a")}\`}, {key:'b', agent:'campaign-scout', model:'claude-bridge/claude-sonnet-5:medium', task: \`${header("b")}\`}])`;
	const req = request({ input: { workflowScript: script, async: true } });
	const readOnly = verdict({ kind: "investigate", expectedHead: null, stopsOnHeadMismatch: false });

	assert.deepEqual(judged(req, [readOnly, readOnly]), { allow: true });

	const { code, reason } = denyJudged(req, [readOnly, verdict()]);
	assert.equal(code, "CG010");
	assert.match(reason, /only child of its own script/);

	assert.equal(denyJudged(req, [readOnly, verdict({ kind: "review" })]).code, "CG006");
});

test("a single-child script carrying one writer is a legal lane, because direct execution no longer exists", () => {
	const header = "ROUTE: s1 | class 1 | claude-bridge/claude-sonnet-5:medium | mechanical edit";
	const script = `return runs.run('s1', {agent:'campaign-worker', model:'claude-bridge/claude-sonnet-5:medium', task: \`${header}\`})`;
	assert.deepEqual(judged(request({ input: { workflowScript: script, async: true } }), [verdict()]), { allow: true });
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
	const script = `runs.all([{key:'a', agent:'campaign-scout', model:'openai-codex/gpt-5.6-luna:high', task: \`${task}\`}])`;
	const { children, agentKeys } = parseScriptChildren(script);
	assert.equal(agentKeys, 1);
	assert.equal(children.length, 1);
});

test("batch and chain inputs are treated as launches rather than slipping past", () => {
	assert.equal(structure(request({ input: { tasks: [{ agent: "worker", task: "x" }] } })).code, "CG017");
	const chain = structure(request({ input: { chain: "legacy", async: true } }));
	assert.equal(chain.code, "CG019");
	assert.match(chain.reason, /\[CG002\]/, "the unpinned model still has to be named in the same refusal");
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
	assert.equal(code, "CG019");
	assert.match(reason, /3 problems/);
	assert.match(reason, /\[CG019\]/);
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

test("a writer fanned out beside another child is told the single-child script form that works", () => {
	const header = (key: string) => `ROUTE: ${key} | class 1 | claude-bridge/claude-sonnet-5:medium | mechanical edit`;
	const script = `return runs.all([{key:'a', agent:'campaign-worker', model:'claude-bridge/claude-sonnet-5:medium', task: \`${header("a")}\`}, {key:'b', agent:'campaign-scout', model:'claude-bridge/claude-sonnet-5:medium', task: \`${header("b")}\`}])`;
	const { code, reason } = denyJudged(request({ input: { workflowScript: script, async: true } }), [
		verdict(),
		verdict({ kind: "investigate", expectedHead: null, stopsOnHeadMismatch: false }),
	]);
	assert.equal(code, "CG010");
	assert.match(reason, /runs\.run\('<key>'/, "must show the single-child script form");
	assert.match(reason, /integrated/, "must say what unblocks the next writer");
	assert.match(reason, /ROUTE:/, "must carry the contract, since the fix is a rewritten dispatch");
});

test("an unroutable model refusal names every model that would work", () => {
	const task = implementTask("ROUTE: s1-parser | class 1 | openai-codex/gpt-9-nova:high | mechanical edit");
	const { code, reason } = structure(request({ input: launch({ model: "openai-codex/gpt-9-nova:high", task }) }));
	assert.equal(code, "CG004");
	for (const listed of ["gpt-5.6-luna:high", "claude-sonnet-5:medium", "gpt-5.6-terra:medium", "claude-opus-5:low", "gpt-5.6-sol:medium"]) {
		assert.match(reason, new RegExp(listed.replace(/[.]/g, "\\.")), `must list ${listed}`);
	}
});

test("CG019: a campaign dispatch runs only with a campaign-owned role", () => {
	const builtin = structure(request({ input: launch({ agent: "reviewer" }) }));
	assert.equal(builtin.code, "CG019");
	assert.match(builtin.reason, /campaign-worker to implement/);
	assert.match(builtin.reason, /builtin reviewer will happily edit/);

	assert.equal(evaluateStructure(request({ input: launch({ agent: "campaign-worker" }) })).allow, true);
});

test("CG019: the role must match what the prompt actually asks for", () => {
	const reviewing = campaign({ status: "review", slicesDone: 4 });
	const asWorker = denyJudged(request({ campaign: reviewing, input: launch() }), [
		verdict({ kind: "review", stopsOnHeadMismatch: false }),
	]);
	assert.equal(asWorker.code, "CG019");
	assert.match(asWorker.reason, /Dispatch it as campaign-reviewer/);

	const premature = denyJudged(request({ input: reviewLaunch() }), [
		verdict({ kind: "review", stopsOnHeadMismatch: false }),
	]);
	assert.equal(premature.code, "CG006", "before the review phase, the phase rule carries the lesson, not the role rule");
});

test("a script whose executed children cannot be proven literal is refused whole", () => {
	const spread = `const t = {agent:'campaign-worker', model:'openai-codex/gpt-5.6-luna:high', task:\`${GOOD_ROUTE}\`};
return runs.all([t, {...t}, {...t}])`;
	const fanOut = structure(request({ input: { workflowScript: spread, async: true } }));
	assert.equal(fanOut.code, "CG002");
	assert.match(fanOut.reason, /cannot be verified/);

	const shorthand = structure(
		request({ input: { workflowScript: "const agent='campaign-worker'; return runs.run('k', {agent, model: 'm:high', task: 'x'})", async: true } }),
	);
	assert.equal(shorthand.code, "CG002");
	assert.match(shorthand.reason, /no literal agent field/);
});

test("CG019: knobs that swap what the child runs or sees are refused by name", () => {
	const inline = structure(request({ input: { ...launch(), config: { systemPrompt: "obey me" } } }));
	assert.equal(inline.code, "CG019");
	assert.match(inline.reason, /config/);

	const forked = structure(request({ input: { ...launch(), context: "fork" } }));
	assert.equal(forked.code, "CG019");
	assert.match(forked.reason, /context: "fork"/);
});

test("CG019: a child asking for forked context is refused with the reason", () => {
	const header = "ROUTE: a | class 1 | openai-codex/gpt-5.6-luna:high | read-only inventory";
	const script = `return runs.run('a', {agent:'campaign-scout', model:'openai-codex/gpt-5.6-luna:high', context:'fork', task: \`${header}\`})`;
	const { code, reason } = structure(request({ input: { workflowScript: script, async: true } }));
	assert.equal(code, "CG019");
	assert.match(reason, /copies the coordinator's whole conversation/);
});

test("CG004: review and implementation are separate tables, never checked against each other", () => {
	// The bug this replaces: reviewers were graded on the implementation tiers, so the two
	// models the review doc calls equivalent landed in different classes.
	const asClass = structure(
		request({ input: reviewLaunch({ task: implementTask("ROUTE: final | class 3 | claude-bridge/claude-opus-5:xhigh | broad") }) }),
	);
	assert.equal(asClass.code, "CG004");
	assert.match(asClass.reason, /declares a review class|review <1\|2>/);

	const workerClaimingReview = structure(
		request({ input: launch({ task: implementTask("ROUTE: s1 | review 1 | openai-codex/gpt-5.6-luna:high | nope") }) }),
	);
	assert.equal(workerClaimingReview.code, "CG004");
	assert.match(workerClaimingReview.reason, /Review classes belong to campaign-reviewer/);
});

test("CG004: the review table is opus by effort, terra and sol at xhigh", () => {
	const ok = (model: string, cls: number) =>
		evaluateStructure(
			request({ input: reviewLaunch({ model, task: implementTask(`ROUTE: r | review ${cls} | ${model} | why`) }) }),
		).allow;

	assert.equal(ok("claude-bridge/claude-opus-5:high", 1), true);
	assert.equal(ok("openai-codex/gpt-5.6-terra:xhigh", 1), true);
	assert.equal(ok("claude-bridge/claude-opus-5:xhigh", 2), true);
	assert.equal(ok("openai-codex/gpt-5.6-sol:xhigh", 2), true);

	// Same model, different effort, different class: the likeliest real refusal.
	assert.equal(ok("claude-bridge/claude-opus-5:high", 2), false);
	// A model with no review row at all.
	assert.equal(ok("openai-codex/gpt-5.6-luna:high", 1), false);
});

test("a refusal never teaches a routing row the same dispatch would be refused for", () => {
	// The reviewer correction used to prescribe "class <1|2|3>", which CG004 then rejected.
	const reviewer = structure(request({ input: reviewLaunch({ model: "claude-bridge/claude-opus-5" }) }));
	assert.match(reviewer.reason, /review <1\|2>/, "a reviewer is taught the review row");
	assert.doesNotMatch(reviewer.reason, /ROUTE: <key> \| class/, "and never the implementation row");

	const worker = structure(request({ input: launch({ model: "gpt-5.6-luna" }) }));
	assert.match(worker.reason, /class <1\|2\|3>/, "a worker is taught the implementation row");
	assert.doesNotMatch(worker.reason, /ROUTE: <key> \| review/, "and never the review row");
});

test("CG012: the top of the review axis needs a reason too, not just class 3", () => {
	const reviewing = campaign({ status: "review", slicesDone: 4 });
	const labelled = denyJudged(
		request({ campaign: reviewing, input: reviewLaunch({ task: implementTask("ROUTE: final | review 2 | claude-bridge/claude-opus-5:xhigh | risky") }) }),
		[verdict({ kind: "review", stopsOnHeadMismatch: false, classJustification: "label" })],
	);
	assert.equal(labelled.code, "CG012");
	assert.match(labelled.reason, /Review 2 is the top of the review table/);

	// Review 1 is the routine choice and carries no such burden.
	const routine = judged(
		request({
			campaign: reviewing,
			input: reviewLaunch({ model: "claude-bridge/claude-opus-5:high", task: implementTask("ROUTE: final | review 1 | claude-bridge/claude-opus-5:high | narrow") }),
		}),
		[verdict({ kind: "review", stopsOnHeadMismatch: false, classJustification: "label" })],
	);
	assert.deepEqual(routine, { allow: true });
});

test("a pin may not sit in two classes on the same axis", () => {
	const tiers = DEFAULT_TIERS;
	assert.match(
		findTierClash(tiers, "class", 3, ["openai-codex/gpt-5.6-luna:high"]) ?? "",
		/already in class 1/,
		"the same pin in two classes makes the enforced class ambiguous",
	);
	assert.equal(findTierClash(tiers, "class", 3, ["claude-bridge/claude-fable-5:high"]), null);
	// The same model at a different effort is a different pin, so it is not a clash.
	assert.equal(findTierClash(tiers, "class", 1, ["claude-bridge/claude-opus-5:xhigh"]), null);
	// Axes are independent: opus:high is review 1 and may still be set on the class axis.
	assert.equal(findTierClash(tiers, "class", 2, ["claude-bridge/claude-opus-5:high"]), null);
});

test("a shape refusal quotes the tiers actually enforced, not a hardcoded mapping", () => {
	const custom = withTierList(DEFAULT_TIERS, "class", 3, ["claude-bridge/claude-fable-5:high"]);
	const { reason } = structure(request({ tiers: custom, input: launch({ model: "gpt-5.6-luna" }) }));
	assert.match(reason, /claude-fable-5:high/, "the override has to appear in the correction");
	assert.doesNotMatch(reason, /class 3 sol or fable/, "and the old static mapping must not");
});

test("parseTierEntries refuses what the pin rule exists to prevent", () => {
	assert.equal(parseTierEntries("openai-codex/gpt-5.6-luna").ok, false, "no effort");
	assert.equal(parseTierEntries("gpt-5.6-luna:high").ok, false, "no provider");
	assert.equal(parseTierEntries("").ok, false, "nothing at all");
	const good = parseTierEntries("openai-codex/gpt-5.6-luna:high, claude-bridge/claude-sonnet-5:medium");
	assert.deepEqual(good.ok && good.entries, ["openai-codex/gpt-5.6-luna:high", "claude-bridge/claude-sonnet-5:medium"]);
});

test("a status block whose slice count contradicts the ledger is not a fresh block", () => {
	// The real case: a campaign printed "6 done / 31 total" every turn while the recorded
	// count stayed at zero, and review opens on the recorded number.
	const block = readStatusBlock(
		["CAMPAIGN demo   WORKTREE /w", "SLICES    6 done / 31 total     NOW: task 7", "PR #1", "AGENTS none", "DIRECT none", "PARKED none", "NEEDS YOU nothing", "NEXT dispatch"].join("\n"),
	);
	assert.equal(block.ok, true);
	assert.equal(block.claimedSlicesDone, 6);
	assert.equal(block.claimedSlicesTotal, 31);

	const behind = campaign({ slicesDone: 0, slicesTotal: 31 });
	assert.match(statusBlockDisagreement(block, behind) ?? "", /6 done of 31, the campaign records 0 of 31/);
	assert.match(statusBlockDisagreement(block, behind) ?? "", /set-slices/);

	const recorded = campaign({ slicesDone: 6, slicesTotal: 31 });
	assert.equal(statusBlockDisagreement(block, recorded), null, "agreement is silence");
});

test("a block whose slice count cannot be read is not a fresh block either", () => {
	const block = readStatusBlock(
		["CAMPAIGN demo   WORKTREE /w", "SLICES in progress", "PR #1", "AGENTS none", "DIRECT none", "PARKED none", "NEEDS YOU nothing", "NEXT dispatch"].join("\n"),
	);
	assert.equal(block.claimedSlicesDone, null);
	// Returning null here was the hole: "SLICES in progress" refreshed the ledger and
	// skipped the comparison entirely.
	assert.match(statusBlockDisagreement(block, campaign({ slicesDone: 3 })) ?? "", /does not state a count/);
});

test("CG020: reaching past the preferred model needs the routing reason to say why", () => {
	// luna is the class 1 fallback; sonnet is preferred. Taking the fallback is allowed, but
	// only when the reason explains it, so "preferred" is not silently ignorable.
	const route = "ROUTE: s1 | class 1 | openai-codex/gpt-5.6-luna:high | mechanical single-file edit";
	const req = request({ input: launch({ model: "openai-codex/gpt-5.6-luna:high", task: implementTask(route) }) });
	const refused = denyJudged(req, [verdict({ classJustification: "substantive" })]);
	assert.equal(refused.code, "CG020", "a thorough description of the work is not a reason to skip the preferred model");
	assert.match(refused.reason, /is a fallback for class 1/);
	assert.match(refused.reason, /claude-bridge\/claude-sonnet-5:medium/, "the refusal names the preferred model");

	// Saying the preferred model was unusable is the whole cost of deviating.
	assert.deepEqual(judged(req, [verdict({ modelUnavailability: "stated" })]), { allow: true });

	// The preferred model never needs one.
	const preferred = request({
		input: launch({ model: "claude-bridge/claude-sonnet-5:medium", task: implementTask("ROUTE: s1 | class 1 | claude-bridge/claude-sonnet-5:medium | mechanical") }),
	});
	assert.deepEqual(judged(preferred, [verdict({ classJustification: "label" })]), { allow: true });
});

test("CG020: a single-entry class has no fallback to justify", () => {
	const only = withTierList(DEFAULT_TIERS, "class", 1, ["claude-bridge/claude-sonnet-5:medium"]);
	const req = request({
		tiers: only,
		input: launch({ model: "claude-bridge/claude-sonnet-5:medium", task: implementTask("ROUTE: s1 | class 1 | claude-bridge/claude-sonnet-5:medium | mechanical") }),
	});
	assert.deepEqual(judged(req, [verdict({ classJustification: "label" })]), { allow: true });
});

test("CG021: managed worktree isolation is refused, because it moves the child off the named path", () => {
	// Measured, not theoretical: worktree:true branches from the session cwd and lands the
	// child in $TMPDIR, so the prompt's worktree and expected HEAD describe somewhere it
	// never goes. Three writers once woke on the session's main branch and refused to work.
	const direct = structure(request({ input: { ...launch(), worktree: true } }));
	assert.equal(direct.code, "CG021");
	assert.match(direct.reason, /branches from the session/);
	// -C anchors the command to the campaign repository; without it the remedy runs wherever
	// the session happens to sit, which is the same wrong-repository bug CG021 exists for.
	assert.match(direct.reason, new RegExp(`git -C ${WORKTREE} worktree add`), "the refusal names the way that works");

	const header = "ROUTE: s1 | class 1 | claude-bridge/claude-sonnet-5:medium | mechanical edit";
	const script = `return runs.run('s1', {agent:'campaign-worker', model:'claude-bridge/claude-sonnet-5:medium', worktree: true, task: \`${header}\`})`;
	const child = structure(request({ input: { workflowScript: script, async: true } }));
	assert.equal(child.code, "CG021");
	assert.match(child.reason, /Create the lane worktree yourself and pass cwd/);

	// worktree:false is not a request for isolation and is left alone.
	assert.equal(evaluateStructure(request({ input: { ...launch(), worktree: false } })).allow, true);
});

test("child fields are read as top-level properties, not found anywhere in the text", () => {
	// The prompt is free-form text that discusses this guard's own vocabulary. Scanning the
	// whole object body for `worktree: true` refused a legal dispatch for quoting the rule.
	const header = "ROUTE: s1 | class 1 | claude-bridge/claude-sonnet-5:medium | mechanical edit";
	const talksAboutIt = `return runs.run('s1', {agent:'campaign-worker', model:'claude-bridge/claude-sonnet-5:medium', task: \`${header}\nDo not ask for worktree: true; the lane worktree already exists.\`})`;
	assert.equal(
		evaluateStructure(request({ input: { workflowScript: talksAboutIt, async: true } })).allow,
		true,
		"a prompt that names the flag is not a request for the flag",
	);

	// And the mirror: a value that is not a literal cannot be read as absent, so it fails closed.
	const computed = `const on = true; return runs.run('s1', {agent:'campaign-worker', model:'claude-bridge/claude-sonnet-5:medium', worktree: on, task: \`${header}\`})`;
	assert.equal(structure(request({ input: { workflowScript: computed, async: true } })).code, "CG021");

	// A model named only inside the prompt is not the child's pin.
	const quotesAModel = `return runs.run('s1', {agent:'campaign-worker', model:'claude-bridge/claude-sonnet-5:medium', task: \`${header}\nThe earlier lane ran model:'openai-codex/gpt-5.6-sol:high' and stalled.\`})`;
	assert.equal(evaluateStructure(request({ input: { workflowScript: quotesAModel, async: true } })).allow, true);
});

test("a child object the scanner cannot consume whole is unverifiable, not clean", () => {
	const header = "ROUTE: s1 | class 1 | claude-bridge/claude-sonnet-5:medium | mechanical edit";
	const pins = `agent:'campaign-worker', model:'claude-bridge/claude-sonnet-5:medium', task: \`${header}\``;

	// Shorthand after the literal fields: the runtime reads whatever the variable holds, so
	// stopping at the first unreadable property and calling the rest absent is a bypass.
	// structure() asserts the launch is refused; the code says why it could not be cleared.
	const shorthand = structure(request({ input: { workflowScript: `const worktree = true; return runs.run('s1', {${pins}, worktree})`, async: true } }));
	assert.equal(shorthand.code, "CG002");
	assert.match(shorthand.reason, /cannot be verified/);

	// A spread can carry the same flag and is equally unreadable.
	assert.equal(structure(request({ input: { workflowScript: `return runs.run('s1', {${pins}, ...defaults})`, async: true } })).code, "CG002");

	// JavaScript property names are case-sensitive: Worktree is a different property and
	// must not overwrite the worktree the runtime actually reads.
	const collided = structure(request({ input: { workflowScript: `return runs.run('s1', {${pins}, worktree: true, Worktree: false})`, async: true } }));
	assert.equal(collided.code, "CG021");
});

test("the GPT preset is OpenAI-only and preserves every class's intended effort", async () => {
	// This is the single user intent behind `/campaign models gpt`: a single provider across
	// implementation, review, and judge, while retaining the calibrated effort for each job.
	const { GPT_DEFAULT_TIERS } = await import("./policy.ts");
	assert.deepEqual(GPT_DEFAULT_TIERS, {
		class: {
			1: ["openai-codex/gpt-5.6-luna:high"],
			2: ["openai-codex/gpt-5.6-terra:medium"],
			3: ["openai-codex/gpt-5.6-sol:medium"],
		},
		review: {
			1: ["openai-codex/gpt-5.6-terra:xhigh"],
			2: ["openai-codex/gpt-5.6-sol:xhigh"],
		},
	});
});
