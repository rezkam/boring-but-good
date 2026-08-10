/**
 * The scanner has to look exactly where pi-subagents looks, prune exactly what it prunes,
 * and never flag the guard's own files. Fixtures live in a temp dir; the real home
 * directory is never touched, which pi-subagents itself once got wrong.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { findRoleShadows } from "./shadows.ts";

const OWN_AGENTS = join(dirname(fileURLToPath(import.meta.url)), "agents");

function fixture(): { root: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "guard-shadows-"));
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function agentFile(dir: string, file: string, name: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, file);
	writeFileSync(path, `---\nname: ${name}\ndescription: decoy\n---\n\nnot ours\n`);
	return path;
}

test("a same-name agent anywhere pi reads is a shadow, whatever the file is called", () => {
	const { root, cleanup } = fixture();
	try {
		const byName = agentFile(root, "campaign-worker.md", "campaign-worker");
		const disguised = agentFile(join(root, "nested"), "innocent.md", "campaign-reviewer");
		agentFile(root, "unrelated.md", "my-own-agent");
		const found = findRoleShadows(OWN_AGENTS, null, [root]);
		assert.deepEqual(found.sort(), [byName, disguised].sort());
	} finally {
		cleanup();
	}
});

test("aliases hijack a name as effectively as names do", () => {
	const { root, cleanup } = fixture();
	try {
		mkdirSync(root, { recursive: true });
		const path = join(root, "sneaky.md");
		writeFileSync(path, "---\nname: helper\naliases: campaign-scout, other\n---\n\nbody\n");
		assert.deepEqual(findRoleShadows(OWN_AGENTS, null, [root]), [path]);
	} finally {
		cleanup();
	}
});

test("what pi prunes is not a shadow: git repos, node_modules, nested project roots, skills", () => {
	const { root, cleanup } = fixture();
	try {
		agentFile(join(root, "node_modules", "pkg"), "campaign-worker.md", "campaign-worker");
		const repo = join(root, "some-repo");
		mkdirSync(join(repo, ".git"), { recursive: true });
		agentFile(repo, "campaign-worker.md", "campaign-worker");
		const project = join(root, "proj");
		mkdirSync(join(project, ".pi"), { recursive: true });
		agentFile(project, "campaign-worker.md", "campaign-worker");
		agentFile(join(root, "skills", "thing"), "campaign-worker.md", "campaign-worker");
		assert.deepEqual(findRoleShadows(OWN_AGENTS, null, [root]), []);
	} finally {
		cleanup();
	}
});

test("the guard's own agents directory is never its own shadow, even through a symlink", () => {
	const { root, cleanup } = fixture();
	try {
		symlinkSync(OWN_AGENTS, join(root, "linked-agents"));
		assert.deepEqual(findRoleShadows(OWN_AGENTS, null, [root]), []);
	} finally {
		cleanup();
	}
});
