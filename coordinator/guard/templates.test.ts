/**
 * The guard and the prompt templates have to agree, and twice now they have not: an
 * implementer template that only said "do not push", and a review template whose expected
 * HEAD lived in the dispatch metadata rather than in the prompt the agent receives. Both
 * meant the guard refused its own prescribed dispatch, and both were found by review rather
 * than by a test.
 *
 * These tests read the templates and assert that the section actually sent to an agent still
 * carries every boundary the judge is asked about. They are the reason that class of defect
 * cannot recur silently: change a template or a rule without the other, and this fails.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { JUDGE_SYSTEM_PROMPT } from "./judge.ts";

const COORDINATOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(name: string): string {
	return readFileSync(join(COORDINATOR_DIR, name), "utf8");
}

/** Everything after the `## Prompt` heading: what a dispatched agent actually receives. */
function promptSection(template: string): string {
	const index = template.indexOf("## Prompt");
	assert.notEqual(index, -1, "template has no ## Prompt section");
	return template.slice(index);
}

test("the implementer template carries every boundary the guard asks the judge about", () => {
	const prompt = promptSection(read("implementer-prompt.md"));

	assert.match(prompt, /ROUTE: \[SLICE KEY\] \| class/, "the routing row must open the prompt");
	assert.match(prompt, /HEAD/, "the prompt must name an expected HEAD");
	assert.match(prompt, /\bstop\b/i, "the prompt must tell the agent to stop when the tree moved");
	assert.match(prompt, /do not push/i, "the prompt must forbid pushing");
	assert.match(prompt, /gh\b/i, "the prompt must forbid running gh");
	assert.match(prompt, /pull request/i, "the prompt must forbid touching the pull request");
	assert.match(prompt, /worktree|working directory/i, "the prompt must state where the work happens");
});

test("the review template carries every boundary the guard asks the judge about", () => {
	const prompt = promptSection(read("review-agent.md"));

	assert.match(prompt, /ROUTE: \[REVIEW KEY\] \| class/, "the routing row must open the prompt");
	assert.match(prompt, /exact HEAD/i, "the reviewed head must appear in the prompt, not only in dispatch metadata");
	assert.match(prompt, /\bstop\b/i, "the prompt must tell the reviewer to stop when the tree moved");
	assert.match(prompt, /push/i, "the prompt must forbid pushing");
	assert.match(prompt, /gh\b/i, "the prompt must forbid running gh");
	assert.match(prompt, /pull request/i, "the prompt must forbid touching the pull request");
});

test("the judge is asked about exactly the boundaries the templates promise", () => {
	// If a boundary is added to the judge contract, a template has to carry it, and the two
	// tests above are what force that. This one keeps the contract itself from drifting.
	for (const field of [
		"expectedHead",
		"stopsOnHeadMismatch",
		"forbidsPush",
		"coordinatorGitWork",
		"worktree",
		"unrenderedPlaceholders",
		"classJustification",
		"kind",
	]) {
		assert.match(JUDGE_SYSTEM_PROMPT, new RegExp(`"${field}"`), `the judge contract must define ${field}`);
	}
});

test("the campaign roles never grant what their boundaries forbid", () => {
	// The builtin reviewer carries edit and write and is told to apply fixes; these roles
	// exist so a campaign never dispatches that. The frontmatter is the enforceable half.
	const files = ["agents/campaign-worker.md", "agents/campaign-reviewer.md", "agents/campaign-scout.md"];
	for (const file of files) {
		const body = readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf8");
		assert.match(body, /systemPromptMode: replace/, `${file} must replace the parent prompt, not append to it`);
		assert.match(body, /inheritSkills: false/, `${file} must not inherit skills`);
		assert.doesNotMatch(body, /defaultContext: fork/, `${file} must not fork the coordinator's conversation`);
		assert.match(body, /[Nn]ever push/, `${file} must forbid pushing`);
		assert.match(body, /gh/, `${file} must forbid gh`);
		assert.match(body, /[Nn]ever spawn subagents/, `${file} must forbid delegation`);
	}
	for (const readOnly of ["agents/campaign-reviewer.md", "agents/campaign-scout.md"]) {
		const tools = readFileSync(join(dirname(fileURLToPath(import.meta.url)), readOnly), "utf8").match(/^tools: (.*)$/m)?.[1] ?? "";
		assert.doesNotMatch(tools, /edit|write/, `${readOnly} must not carry edit or write tools`);
	}
});
