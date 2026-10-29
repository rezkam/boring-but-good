import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function codexFastMode(pi: ExtensionAPI): void {
	const isCodex = (model: ExtensionContext["model"]) =>
		model?.provider === "openai-codex" && model.api === "openai-codex-responses";

	function updateStatus(ctx: ExtensionContext, model = ctx.model): void {
		if (ctx.hasUI) {
			ctx.ui.setStatus("codex-fast-mode", isCodex(model)
				? ctx.ui.theme.fg("success", "Codex fast: priority")
				: undefined);
		}
	}

	pi.on("session_start", (_event, ctx) => updateStatus(ctx));
	pi.on("model_select", (event, ctx) => updateStatus(ctx, event.model));
	pi.on("before_provider_request", (event, ctx) => {
		if (isCodex(ctx.model) && event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
			return { ...event.payload, service_tier: "priority" };
		}
	});
}
