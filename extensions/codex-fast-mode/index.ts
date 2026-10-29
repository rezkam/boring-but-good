import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function codexFastMode(pi: ExtensionAPI): void {
	let enabled = false;
	const isCodex = (model: ExtensionContext["model"]) =>
		model?.provider === "openai-codex" && model.api === "openai-codex-responses";

	function updateStatus(ctx: ExtensionContext, model = ctx.model): void {
		if (ctx.hasUI) {
			ctx.ui.setStatus("codex-fast-mode", enabled && isCodex(model)
				? ctx.ui.theme.fg("success", "Codex fast: priority")
				: undefined);
		}
	}

	pi.registerCommand("codex-fast", {
		description: "Codex fast mode: on, off, or show status",
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			if (mode !== "" && mode !== "on" && mode !== "off") {
				ctx.ui.notify("Usage: /codex-fast [on|off]", "warning");
				return;
			}
			if (mode) enabled = mode === "on";
			updateStatus(ctx);
			ctx.ui.notify(enabled
				? "Codex fast mode: on (priority requested for Codex models)"
				: "Codex fast mode: off (normal requests)", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => updateStatus(ctx));
	pi.on("model_select", (event, ctx) => updateStatus(ctx, event.model));
	pi.on("before_provider_request", (event, ctx) => {
		if (enabled && isCodex(ctx.model) && event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
			return { ...event.payload, service_tier: "priority" };
		}
	});
}
