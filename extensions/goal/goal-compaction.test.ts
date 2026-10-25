import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import goalExtension from "./index.ts";

const root = process.env.SOL_PI_ROOT;
const skip = !root && "Set SOL_PI_ROOT to test against the installed compaction extension";
const open = [{ id: "work", goal: "Verify the work", status: "in_progress" }];
const done = [{ ...open[0], status: "completed" }];
const progress = { files_changed: ["test.ts"], verification: ["verified"], decisions: ["small change"] };

async function runGoalSession(options: {
	id: string;
	goalFirst: boolean;
	responses: (faux: any, compactions: () => number) => any[];
	summarize: boolean;
}) {
	const load = (path: string) => import(pathToFileURL(join(root!, path)).href);
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await load("node_modules/@earendil-works/pi-coding-agent/dist/index.js");
	const fauxApi = await load("node_modules/@earendil-works/pi-ai/dist/providers/faux.js");
	const { createOnlineContextCompactExtension } = await load("src/sol-pi/extensions/online-context-compact/extension.ts");
	const cwd = await mkdtemp(join(tmpdir(), "goal-compaction-"));
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir);
	let session: any;
	try {
		const faux = fauxApi.fauxProvider({ provider: `goal-${options.id}`, api: `goal-${options.id}-api`, models: [{ id: "test", contextWindow: 4096, maxTokens: 1024 }] });
		const manager = SessionManager.inMemory(cwd);
		faux.setResponses(options.responses(fauxApi, () => manager.getBranch().filter((e: any) => e.type === "compaction").length));
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 150, reserveTokens: 1024 }, retry: { enabled: false } });
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "history " + "x".repeat(6000) }], timestamp: Date.now() });
		manager.appendMessage(fauxApi.fauxAssistantMessage("prior work " + "y".repeat(6000)));
		const resourceLoader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			extensionFactories: [{ name: "goal-compaction-test", factory: (pi: any) => {
				pi.registerProvider(faux.provider);
				if (options.goalFirst) goalExtension(pi);
				createOnlineContextCompactExtension({ cacheWriteReadRatio: 0, keepRecentTokens: 150 })(pi);
				if (!options.goalFirst) goalExtension(pi);
				// Without this hook, pi asks the faux model for the summary, so its scripted reply decides the outcome.
				if (options.summarize) pi.on("session_before_compact", (event: any) => ({ compaction: {
					summary: "compacted evidence " + "s".repeat(6000),
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				} }));
			} }],
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "Run the deterministic lifecycle verification.",
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		({ session } = await createAgentSession({ cwd, agentDir, model: faux.getModel(), thinkingLevel: "off", tools: ["create_goal", "update_plan", "update_goal"], resourceLoader, sessionManager: manager, settingsManager }));
		await session.prompt("Create a goal and finish the work.", { expandPromptTemplates: false, source: "interactive" });
		// prompt() can return while a turn started during agent_settled is still running.
		await session.waitForIdle();
		const entries = manager.getBranch();
		const states = entries.filter((e: any) => e.type === "custom" && e.customType === "goal").map((e: any) => e.data.goal.status);
		assert.ok(states.every((status: string) => status === "active" || status === "complete"), JSON.stringify({ states, errors: entries.filter((e: any) => e.type === "message" && e.message.stopReason === "error") }));
		assert.equal(states.at(-1), "complete");
		assert.equal(session.getLastAssistantText(), "All verification finished.");
		assert.equal(session.isIdle, true);
		return {
			compactions: entries.filter((e: any) => e.type === "compaction").length,
			continuations: entries.filter((e: any) => e.type === "custom_message" && e.customType === "goal-continuation").length,
		};
	} finally {
		session?.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
}

const toolResponse = (faux: any, name: string, args: any, id: string) => faux.fauxAssistantMessage(faux.fauxToolCall(name, args, { id }), { stopReason: "toolUse" });

for (const goalFirst of [true, false]) {
	const order = `goal loaded ${goalFirst ? "first" : "last"}`;

	test(`active goal survives two real online compactions, ${order}`, { skip, timeout: 15_000 }, async () => {
		const result = await runGoalSession({ id: `twice-${goalFirst}`, goalFirst, summarize: true, responses: (faux, compactions) => [
			toolResponse(faux, "create_goal", { objective: "Complete both compaction phases" }, "create"),
			toolResponse(faux, "update_plan", { steps: open }, "open-1"),
			toolResponse(faux, "update_plan", { steps: done, progress }, "done-1"),
			async () => {
				assert.equal(compactions(), 1);
				return faux.fauxAssistantMessage([faux.fauxText("second phase " + "z".repeat(6000)), faux.fauxToolCall("update_plan", { steps: open }, { id: "open-2" })], { stopReason: "toolUse" });
			},
			toolResponse(faux, "update_plan", { steps: done, progress }, "done-2"),
			async () => {
				assert.equal(compactions(), 2);
				return faux.fauxAssistantMessage("One verification remains.");
			},
			toolResponse(faux, "update_goal", { status: "complete" }, "complete"),
			faux.fauxAssistantMessage("All verification finished."),
		] });
		assert.deepEqual(result, { compactions: 2, continuations: 1 });
	});

	test(`active goal continues after a real online compaction fails, ${order}`, { skip, timeout: 15_000 }, async () => {
		const result = await runGoalSession({ id: `failed-${goalFirst}`, goalFirst, summarize: false, responses: faux => [
			toolResponse(faux, "create_goal", { objective: "Finish despite a failed compaction" }, "create"),
			toolResponse(faux, "update_plan", { steps: open }, "open"),
			toolResponse(faux, "update_plan", { steps: done, progress }, "done"),
			faux.fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary model failed" }),
			toolResponse(faux, "update_goal", { status: "complete" }, "complete"),
			faux.fauxAssistantMessage("All verification finished."),
			// Current SoL-Pi also sends its own recovery continuation after compaction fails.
			faux.fauxAssistantMessage("All verification finished."),
		] });
		assert.deepEqual(result, { compactions: 0, continuations: 1 });
	});
}
