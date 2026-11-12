import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type CodexAuth = {
	access?: string;
	accountId?: string;
};

type CodexWindow = {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_at?: number;
};

type CodexUsagePayload = {
	rate_limit?: {
		primary_window?: CodexWindow | null;
		secondary_window?: CodexWindow | null;
	};
};

type CodexLimits = {
	primary?: CodexWindow;
	secondary?: CodexWindow;
};

const STATUS_KEY = "codex-limits";
const REFRESH_INTERVAL_MS = 60_000;
const AUTH_FILE = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");

export default function (pi: ExtensionAPI) {
	let latestLimits: CodexLimits | undefined;
	let lastRefresh = 0;
	let refreshGeneration = 0;
	let countdownTimer: ReturnType<typeof setInterval> | undefined;

	function startCountdown(ctx: ExtensionContext) {
		if (countdownTimer) clearInterval(countdownTimer);
		countdownTimer = setInterval(() => renderLimits(ctx), REFRESH_INTERVAL_MS);
		countdownTimer.unref?.();
	}

	function isCodexModel(model: unknown): boolean {
		const candidate = model as { provider?: string } | undefined;
		return typeof candidate?.provider === "string" && candidate.provider.startsWith("openai-codex");
	}

	function readCodexAuth(): CodexAuth | undefined {
		try {
			if (!existsSync(AUTH_FILE)) return undefined;
			const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Record<string, CodexAuth>;
			return auth["openai-codex"];
		} catch {
			return undefined;
		}
	}

	function usedPercent(window: CodexWindow | undefined): number | undefined {
		if (typeof window?.used_percent !== "number" || !Number.isFinite(window.used_percent)) return undefined;
		return Math.round(Math.max(0, Math.min(100, window.used_percent)));
	}

	function resetCountdown(resetAt: number | undefined): string {
		if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= 0) return "";
		const minutes = Math.max(0, Math.ceil((resetAt * 1000 - Date.now()) / 60000));
		const days = Math.floor(minutes / 1440);
		const hours = Math.floor(minutes % 1440 / 60);
		const duration = `${days > 0 ? `${days}d` : ""}${days > 0 || hours > 0 ? `${hours}h` : ""}${minutes % 60}m`;
		return ` (resets in ${duration})`;
	}

	function renderLimits(ctx: ExtensionContext, limits: CodexLimits | undefined = latestLimits) {
		if (!isCodexModel(ctx.model)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const theme = ctx.ui.theme;
		if (!limits) {
			ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "Codex limits …"));
			return;
		}

		const style = (value: number) => {
			const text = `${value}%`;
			if (value >= 90) return theme.fg("error", text);
			if (value >= 75) return theme.fg("warning", text);
			return theme.fg("success", text);
		};

		const showLabels = [limits.primary, limits.secondary].filter((window) => usedPercent(window) !== undefined).length > 1;
		const windows = [limits.primary, limits.secondary].flatMap((window, index) => {
			const used = usedPercent(window);
			if (used === undefined) return [];
			const seconds = window?.limit_window_seconds;
			let label = index === 0 ? "5h" : "7d";
			if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
				label = seconds % 86400 === 0 ? `${seconds / 86400}d`
					: seconds % 3600 === 0 ? `${seconds / 3600}h` : `${Math.round(seconds / 60)}m`;
			}
			return [`${showLabels ? `${label} ` : ""}${style(used)}${theme.fg("dim", resetCountdown(window?.reset_at))}`];
		});
		ctx.ui.setStatus(
			STATUS_KEY,
			windows.length > 0
				? `${theme.fg("dim", "Codex used")} ${windows.join(` ${theme.fg("dim", "·")} `)}`
				: theme.fg("dim", "Codex limits …"),
		);
	}

	async function refreshLimits(ctx: ExtensionContext, force = false) {
		const generation = ++refreshGeneration;
		if (!isCodexModel(ctx.model)) {
			renderLimits(ctx);
			return;
		}

		const now = Date.now();
		if (!force && latestLimits && now - lastRefresh < REFRESH_INTERVAL_MS) {
			renderLimits(ctx);
			return;
		}

		renderLimits(ctx);

		try {
			const auth = readCodexAuth();
			if (!auth?.access || !auth.accountId) return;

			const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
				headers: {
					Authorization: `Bearer ${auth.access}`,
					"ChatGPT-Account-Id": auth.accountId,
					"User-Agent": "pi-coding-agent",
					originator: "pi",
				},
				signal: ctx.signal,
			});
			if (!response.ok) return;

			const payload = (await response.json()) as CodexUsagePayload;
			if (generation !== refreshGeneration) return;

			latestLimits = {
				primary: payload.rate_limit?.primary_window ?? undefined,
				secondary: payload.rate_limit?.secondary_window ?? undefined,
			};
			lastRefresh = Date.now();
			renderLimits(ctx, latestLimits);
		} catch {
			// Keep the previous status; transient auth/network failures should not be noisy.
		}
	}

	function updateFromHeaders(ctx: ExtensionContext, headers: Record<string, string | string[] | undefined>) {
		if (!isCodexModel(ctx.model)) return;
		const header = (name: string): string | undefined => {
			const value = headers[name] ?? headers[name.toLowerCase()];
			return Array.isArray(value) ? value[0] : value;
		};
		const primaryUsed = Number(header("x-codex-primary-used-percent"));
		const secondaryUsed = Number(header("x-codex-secondary-used-percent"));
		if (!Number.isFinite(primaryUsed) && !Number.isFinite(secondaryUsed)) return;

		const updateWindow = (slot: "primary" | "secondary", used: number): CodexWindow | undefined => {
			const previous = latestLimits?.[slot];
			if (!Number.isFinite(used)) return previous;
			const minutes = Number(header(`x-codex-${slot}-window-minutes`));
			const resetAfter = Number(header(`x-codex-${slot}-reset-after-seconds`));
			return {
				used_percent: used,
				reset_at: Number.isFinite(resetAfter) && resetAfter >= 0
					? Date.now() / 1000 + resetAfter : previous?.reset_at,
				limit_window_seconds: Number.isFinite(minutes) && minutes > 0
					? minutes * 60 : previous?.limit_window_seconds,
			};
		};
		latestLimits = {
			primary: updateWindow("primary", primaryUsed),
			secondary: updateWindow("secondary", secondaryUsed),
		};
		lastRefresh = Date.now();
		renderLimits(ctx, latestLimits);
	}

	pi.on("session_start", async (_event, ctx) => {
		startCountdown(ctx);
		await refreshLimits(ctx, true);
	});

	pi.on("model_select", async (_event, ctx) => {
		startCountdown(ctx);
		await refreshLimits(ctx, true);
	});

	pi.on("session_shutdown", () => {
		if (countdownTimer) clearInterval(countdownTimer);
		countdownTimer = undefined;
	});

	pi.on("after_provider_response", async (event, ctx) => {
		updateFromHeaders(ctx, event.headers ?? {});
	});

	pi.on("agent_end", async (_event, ctx) => {
		await refreshLimits(ctx, true);
	});
}
