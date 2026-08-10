/**
 * Files that would shadow the campaign roles. The extras directory the extension
 * registers is the lowest-precedence user source in pi-subagents, so an agent file with
 * the same name anywhere the user or project provides agents silently replaces the
 * guard's prompt while the name check still approves it. Scanned once per session: a
 * shadow is a file someone placed, not a race.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

import { CAMPAIGN_AGENTS } from "./policy.ts";

const CAMPAIGN_ROLE_NAMES = new Set(Object.keys(CAMPAIGN_AGENTS));

/**
 * Files that would shadow the campaign roles. The extras directory this extension
 * registers is the lowest-precedence user source in pi-subagents, so an agent file with
 * the same name anywhere the user or project provides agents silently replaces the
 * guard's prompt while checkCampaignAgent still approves the name. Scanned once per
 * session: a shadow is a file someone placed, not a race.
 */
export function findRoleShadows(ownAgentsDir: string, worktree: string | null, rootsOverride?: string[]): string[] {
	const own = safeRealpath(ownAgentsDir);
	const roots = rootsOverride ?? [joinPath(homedir(), ".pi", "agent", "agents"), joinPath(homedir(), ".agents")];
	if (!rootsOverride) {
		for (const base of [process.cwd(), worktree].filter((value): value is string => value !== null)) {
			roots.push(joinPath(base, ".agents"), joinPath(base, ".pi", "agents"));
		}
	}
	const shadows: string[] = [];
	const seen = new Set<string>();
	const isDir = (target: string) => {
		try {
			return lstatSync(target).isDirectory();
		} catch {
			return false;
		}
	};
	// Mirrors pi-subagents' own discovery prunes: git repos, node_modules, and nested
	// project roots are places it never reads, so a file there is not a shadow and must not
	// be flagged as one.
	const pruned = (dir: string, name: string, root: string) =>
		name === ".git" ||
		name === "node_modules" ||
		isDir(joinPath(dir, ".git")) ||
		existsSync(joinPath(dir, ".git")) ||
		(dir !== root && (isDir(joinPath(dir, ".pi")) || isDir(joinPath(dir, ".agents"))));
	const walk = (dir: string, root: string, underSkills: boolean) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = joinPath(dir, entry.name);
			if (entry.isDirectory()) {
				if (!pruned(full, entry.name, root)) {
					walk(full, root, underSkills || entry.name.toLowerCase() === "skills");
				}
				continue;
			}
			if (underSkills) continue;
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			if (!entry.name.endsWith(".md") || entry.name.endsWith(".chain.md")) continue;
			if (safeRealpath(dir) === own) continue;
			let head: string;
			try {
				head = readFileSync(full, "utf8").slice(0, 2000);
			} catch {
				continue;
			}
			if (!head.startsWith("---")) continue;
			const front = head.split("\n---")[0];
			const named = /^(?:name|aliases):\s*(.+)$/gm;
			for (let match = named.exec(front); match; match = named.exec(front)) {
				for (const candidate of match[1].split(",").map((value) => value.trim())) {
					if (CAMPAIGN_ROLE_NAMES.has(candidate) && !seen.has(full)) {
						seen.add(full);
						shadows.push(full);
					}
				}
			}
		}
	};
	for (const root of roots) {
		if (!isDir(root)) continue;
		walk(root, root, false);
	}
	return shadows;
}

export function safeRealpath(target: string): string {
	try {
		return realpathSync(target);
	} catch {
		return target;
	}
}
