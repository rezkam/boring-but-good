/**
 * Observed output throughput per model, read from pi's own session files.
 *
 * dispatch.md has always said to pick the fastest model in the selected class, measured as
 * returned tokens over elapsed seconds, and nothing measured it. This does, from real runs
 * rather than a synthetic benchmark.
 *
 * The measurement is deliberately coarse and must be read as a ranking, not a benchmark:
 * an assistant message records its output tokens but not its own duration, so elapsed time
 * is the gap to the previous entry, which also contains queueing and tool time. Samples
 * with an implausible gap or a tiny output are dropped, and a model with too few samples
 * reports nothing rather than a number that would be noise.
 *
 * Samples are keyed by the full pin, effort included, because effort is the whole point of
 * the distinction: opus at low and opus at xhigh are different classes, and one mixed rate
 * for both would rank a class using a materially different workload. Effort is not on the
 * message, so it is tracked from thinking_level_change events as the file is read.
 *
 * Subagent transcripts live nested under <session>/<run>/run-N/session.jsonl, which is
 * where campaign workers and reviewers appear. A reader that only looked at the top level
 * missed roughly a third of the files and therefore most dispatched work.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { TierLists } from "./policy.ts";

export interface Throughput {
	tokensPerSecond: number;
	samples: number;
}

/** Below this, one slow turn dominates the average and the number means nothing. */
const MIN_SAMPLES = 5;
const MIN_OUTPUT_TOKENS = 50;
const MIN_GAP_SECONDS = 0.5;
const MAX_GAP_SECONDS = 600;

export function readThroughput(
	sessionsRoot: string = join(homedir(), ".pi", "agent", "sessions"),
	maxFiles = 40,
): Map<string, Throughput> {
	const totals = new Map<string, { tokens: number; seconds: number; samples: number }>();
	for (const file of recentSessionFiles(sessionsRoot, maxFiles)) {
		accumulate(file, totals);
	}
	const result = new Map<string, Throughput>();
	for (const [model, total] of totals) {
		if (total.samples < MIN_SAMPLES || total.seconds <= 0) continue;
		result.set(model, { tokensPerSecond: total.tokens / total.seconds, samples: total.samples });
	}
	return result;
}

/** Depth enough for <project>/<session>/<run>/run-N/session.jsonl, and no deeper. */
const MAX_DEPTH = 5;

function recentSessionFiles(root: string, maxFiles: number): string[] {
	const files: Array<{ path: string; mtime: number }> = [];
	const walk = (dir: string, depth: number) => {
		if (depth > MAX_DEPTH) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(path, depth + 1);
				continue;
			}
			if (!entry.name.endsWith(".jsonl")) continue;
			try {
				files.push({ path, mtime: statSync(path).mtimeMs });
			} catch {
				continue;
			}
		}
	};
	walk(root, 0);
	return files
		.sort((left, right) => right.mtime - left.mtime)
		.slice(0, maxFiles)
		.map((entry) => entry.path);
}

function accumulate(file: string, totals: Map<string, { tokens: number; seconds: number; samples: number }>): void {
	let content: string;
	try {
		content = readFileSync(file, "utf8");
	} catch {
		return;
	}
	let previous: number | null = null;
	let effort: string | null = null;
	for (const line of content.split("\n")) {
		if (line.length === 0) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const at = timestampOf(entry.timestamp);
		if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
			effort = entry.thinkingLevel;
		}
		const message = entry.message as Record<string, unknown> | undefined;
		const usage = message?.usage as { output?: unknown } | undefined;
		const output = typeof usage?.output === "number" ? usage.output : null;

		if (message?.role === "assistant" && output !== null && at !== null && previous !== null) {
			const seconds = (at - previous) / 1000;
			if (seconds > MIN_GAP_SECONDS && seconds < MAX_GAP_SECONDS && output > MIN_OUTPUT_TOKENS) {
				const key = `${String(message.provider ?? "unknown")}/${String(message.model ?? "unknown")}:${effort ?? "unstated"}`;
				const total = totals.get(key) ?? { tokens: 0, seconds: 0, samples: 0 };
				total.tokens += output;
				total.seconds += seconds;
				total.samples += 1;
				totals.set(key, total);
			}
		}
		if (at !== null) previous = at;
	}
}

function timestampOf(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The measured rate for a pin, matched on the bare model name so a list entry written for
 * one provider still finds samples recorded under another.
 */
export function rateFor(measured: Map<string, Throughput>, pin: string): Throughput | null {
	const wanted = bare(pin);
	const wantedEffort = effortOf(pin);
	for (const [key, value] of measured) {
		if (bare(key) === wanted && effortOf(key) === wantedEffort) return value;
	}
	return null;
}

function bare(pin: string): string {
	const withoutEffort = pin.includes(":") ? pin.slice(0, pin.lastIndexOf(":")) : pin;
	const slash = withoutEffort.lastIndexOf("/");
	return (slash === -1 ? withoutEffort : withoutEffort.slice(slash + 1)).toLowerCase();
}

function effortOf(pin: string): string {
	const colon = pin.lastIndexOf(":");
	return colon === -1 ? "unstated" : pin.slice(colon + 1).toLowerCase();
}

/**
 * Each class reordered so the fastest measured entry leads. Entries with no measurement
 * keep their relative position behind the measured ones rather than being guessed at: a
 * model with no samples is unknown, not slow.
 */
export function reorderByThroughput(
	tiers: TierLists,
	measured: Map<string, Throughput>,
): { tiers: TierLists; changed: string[] } {
	const next: TierLists = { class: { ...tiers.class }, review: { ...tiers.review } };
	const changed: string[] = [];
	for (const [axis, lists] of [
		["class", next.class],
		["review", next.review],
	] as const) {
		for (const [cls, entries] of Object.entries(lists) as Array<[string, string[]]>) {
			// Only the measured entries are sorted, and they are placed back into the positions
			// they already occupied. An unmeasured entry keeps its index: no samples means
			// unknown, and moving a measured entry ahead of it would treat unknown as slow.
			const measuredIndices = entries.map((entry, index) => ({ entry, index, rate: rateFor(measured, entry) })).filter((row) => row.rate !== null);
			const sorted = [...measuredIndices].sort((left, right) => (right.rate?.tokensPerSecond ?? 0) - (left.rate?.tokensPerSecond ?? 0));
			const ranked = [...entries];
			measuredIndices.forEach((row, position) => {
				ranked[row.index] = sorted[position].entry;
			});
			if (ranked.join("|") !== entries.join("|")) {
				changed.push(`${axis} ${cls}`);
				(lists as Record<string, string[]>)[cls] = ranked;
			}
		}
	}
	return { tiers: next, changed };
}
