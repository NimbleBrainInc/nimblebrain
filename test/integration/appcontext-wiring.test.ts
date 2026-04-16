import { afterAll, describe, expect, it } from "bun:test";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { ToolSource } from "../../src/tools/types.ts";
import type { ToolResult } from "../../src/engine/types.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

/** Minimal model adapter that captures the system prompt for assertions. */
function createCapturingModel() {
	let capturedSystem = "";
	const adapter = createMockModel((options) => {
		const systemMsg = options.prompt.find((m) => m.role === "system");
		if (systemMsg && typeof systemMsg.content === "string") {
			// Skip auto-title calls
			if (!systemMsg.content.includes("Generate a 3-6 word title")) {
				capturedSystem = systemMsg.content;
			}
		}
		return {
			content: [{ type: "text", text: "ok" }],
			inputTokens: 10,
			outputTokens: 5,
		};
	});
	return {
		adapter,
		getSystem: () => capturedSystem,
	};
}

/** Fake ToolSource that returns predictable tools. */
function createFakeSource(name: string, tools: Array<{ localName: string; description: string }>): ToolSource {
	return {
		name,
		async start() {},
		async stop() {},
		async tools() {
			return tools.map((t) => ({
				name: `${name}__${t.localName}`,
				description: t.description,
				inputSchema: {},
				source: `mcpb:${name}`,
			}));
		},
		async execute(_toolName: string, _input: Record<string, unknown>): Promise<ToolResult> {
			return { content: textContent("ok"), isError: false };
		},
	};
}

describe("Runtime.chat() appContext wiring", () => {
	it("passes focusedApp to composeSystemPrompt when appContext matches a source", async () => {
		const { adapter, getSystem } = createCapturingModel();
		const runtime = await Runtime.start({
			model: { provider: "custom", adapter },
			noDefaultBundles: true,
			logging: { disabled: true },
		});

		await provisionTestWorkspace(runtime);

		// Add a fake source to the workspace registry
		const source = createFakeSource("my-server", [
			{ localName: "create_item", description: "Creates an item" },
			{ localName: "list_items", description: "Lists all items" },
		]);
		runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(source);

		await runtime.chat({
			message: "Hello",
			workspaceId: TEST_WORKSPACE_ID,
			appContext: { appName: "My App", serverName: "my-server" },
		});

		const system = getSystem();
		// The focused app section should be present
		expect(system).toContain("Active App: My App");
		// Tool names are no longer listed inline in the focused app section;
		// the section now contains the app guide and interaction rules.
		expect(system).toContain("Interaction Rules");

		await runtime.shutdown();
	});

	it("does not inject focusedApp when appContext is absent", async () => {
		const { adapter, getSystem } = createCapturingModel();
		const runtime = await Runtime.start({
			model: { provider: "custom", adapter },
			noDefaultBundles: true,
			logging: { disabled: true },
		});

		await provisionTestWorkspace(runtime);

		await runtime.chat({ message: "Hello", workspaceId: TEST_WORKSPACE_ID });

		const system = getSystem();
		expect(system).not.toContain("Active App:");

		await runtime.shutdown();
	});

	it("skips silently when serverName does not match any source", async () => {
		const { adapter, getSystem } = createCapturingModel();
		const runtime = await Runtime.start({
			model: { provider: "custom", adapter },
			noDefaultBundles: true,
			logging: { disabled: true },
		});

		await provisionTestWorkspace(runtime);

		await runtime.chat({
			message: "Hello",
			workspaceId: TEST_WORKSPACE_ID,
			appContext: { appName: "Ghost App", serverName: "nonexistent-server" },
		});

		const system = getSystem();
		// No focused app section should appear
		expect(system).not.toContain("Active App:");
		// Chat still succeeds (response is the echoed message)

		await runtime.shutdown();
	});
});
