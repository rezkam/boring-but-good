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
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

function recentSessionFiles(root: string, maxFiles: number): string[] {
	let dirs: string[];
	try {
		dirs = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(root, entry.name));
	} catch {
		return [];
	}
	const files: Array<{ path: string; mtime: number }> = [];
	for (const dir of dirs) {
		let names: string[];
		try {
			names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const name of names) {
			const path = join(dir, name);
			try {
				files.push({ path, mtime: statSync(path).mtimeMs });
			} catch {
				continue;
			}
		}
	}
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
	for (const line of content.split("\n")) {
		if (line.length === 0) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const at = timestampOf(entry.timestamp);
		const message = entry.message as Record<string, unknown> | undefined;
		const usage = message?.usage as { output?: unknown } | undefined;
		const output = typeof usage?.output === "number" ? usage.output : null;

		if (message?.role === "assistant" && output !== null && at !== null && previous !== null) {
			const seconds = (at - previous) / 1000;
			if (seconds > MIN_GAP_SECONDS && seconds < MAX_GAP_SECONDS && output > MIN_OUTPUT_TOKENS) {
				const key = `${String(message.provider ?? "unknown")}/${String(message.model ?? "unknown")}`;
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
	for (const [key, value] of measured) {
		if (bare(key) === wanted) return value;
	}
	return null;
}

function bare(pin: string): string {
	const withoutEffort = pin.includes(":") ? pin.slice(0, pin.lastIndexOf(":")) : pin;
	const slash = withoutEffort.lastIndexOf("/");
	return (slash === -1 ? withoutEffort : withoutEffort.slice(slash + 1)).toLowerCase();
}
