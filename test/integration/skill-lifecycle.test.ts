import { describe, expect, it, afterAll } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createMockModel } from "../helpers/mock-model.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-skill-lifecycle-${Date.now()}`);

afterAll(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

/** Model adapter that captures the system prompt for inspection. Ignores auto-title calls. */
function createCapturingModel(): { model: LanguageModelV3; getSystem: () => string } {
	let capturedSystem = "";
	const model = createMockModel((options) => {
		const systemMsg = options.prompt.find((m) => m.role === "system");
		if (systemMsg && typeof systemMsg.content === "string") {
			// Skip auto-title calls (they have a short, distinctive system prompt)
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
	return { model, getSystem: () => capturedSystem };
}

/** Helper to call a tool via the registry and return the result. */
async function callTool(
	runtime: Runtime,
	toolName: string,
	input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
	const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
	const result = await runWithRequestContext(
		{ identity: null, workspaceId: TEST_WORKSPACE_ID, workspaceAgents: null, workspaceModelOverride: null },
		() => registry.execute({
			id: `test-${Date.now()}`,
			name: toolName,
			input,
		}),
	);
	return {
		content: extractText(result.content),
		isError: result.isError ?? false,
	};
}

describe("skill lifecycle (end-to-end)", () => {
	it("full create -> match -> compose -> delete cycle", async () => {
		const workDir = join(testDir, "full-cycle");
		const { model, getSystem } = createCapturingModel();

		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: model },
			noDefaultBundles: true,
			workDir,
			logging: { disabled: true },
			telemetry: { enabled: false },
		});
		await provisionTestWorkspace(runtime);

		// 1. Create a skill via nb__manage_skill
		const createResult = await callTool(runtime, "nb__manage_skill", {
			action: "create",
			name: "test-greeter",
			skill: {
				description: "Greets people warmly",
				type: "skill",
				priority: 50,
				body: "You are a warm and friendly greeter. Always say hello enthusiastically.",
				triggers: ["greet someone", "say hello"],
				keywords: ["hello", "greet", "welcome", "hi"],
			},
		});
		expect(createResult.isError).toBe(false);
		expect(createResult.content).toContain("created successfully");

		// 2. Verify it appears in nb__status scope=skills output
		const statusResult = await callTool(runtime, "nb__status", { scope: "skills" });
		expect(statusResult.isError).toBe(false);
		expect(statusResult.content).toContain("test-greeter");

		// 3. Verify the skill matcher matches it when given a message with its trigger
		const chatResult = await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "greet someone please" });
		expect(chatResult.skillName).toBe("test-greeter");

		// 4. Verify the skill body appears in composed system prompt
		expect(getSystem()).toContain("warm and friendly greeter");

		// 5. Delete it via nb__manage_skill
		const deleteResult = await callTool(runtime, "nb__manage_skill", {
			action: "delete",
			name: "test-greeter",
		});
		expect(deleteResult.isError).toBe(false);
		expect(deleteResult.content).toContain("deleted successfully");

		// 6. Verify it no longer matches
		const chatAfterDelete = await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "greet someone please" });
		expect(chatAfterDelete.skillName).not.toBe("test-greeter");

		await runtime.shutdown();
	});

	it("context skill is always-on in system prompt", async () => {
		const workDir = join(testDir, "context-skill");
		const { model, getSystem } = createCapturingModel();

		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: model },
			noDefaultBundles: true,
			workDir,
			logging: { disabled: true },
			telemetry: { enabled: false },
		});
		await provisionTestWorkspace(runtime);

		// Create a context skill with priority 20 (above core threshold of 10)
		const createResult = await callTool(runtime, "nb__manage_skill", {
			action: "create",
			name: "team-context",
			skill: {
				description: "Team-specific context",
				type: "context",
				priority: 20,
				body: "You are working for Acme Corp. Always mention the company name.",
			},
		});
		expect(createResult.isError).toBe(false);

		// Send a message with NO trigger match — context skill should still appear
		await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "what is 2 + 2" });
		expect(getSystem()).toContain("Acme Corp");

		// Send a completely different message — context skill should still be present
		await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "tell me about the weather" });
		expect(getSystem()).toContain("Acme Corp");

		// Delete and verify removal
		const deleteResult = await callTool(runtime, "nb__manage_skill", {
			action: "delete",
			name: "team-context",
		});
		expect(deleteResult.isError).toBe(false);

		await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "anything at all" });
		expect(getSystem()).not.toContain("Acme Corp");

		await runtime.shutdown();
	});

	it("dependency warning when required bundle is missing", async () => {
		const workDir = join(testDir, "dep-warning");
		const { model, getSystem } = createCapturingModel();

		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: model },
			noDefaultBundles: true,
			workDir,
			logging: { disabled: true },
			telemetry: { enabled: false },
		});
		await provisionTestWorkspace(runtime);

		// Create a skill that requires a nonexistent bundle
		const createResult = await callTool(runtime, "nb__manage_skill", {
			action: "create",
			name: "dep-skill",
			skill: {
				description: "Skill with missing dependency",
				type: "skill",
				priority: 50,
				body: "You are a data processor.",
				triggers: ["process data"],
				keywords: ["process", "data", "analyze"],
				requires_bundles: ["@nonexistent/bundle"],
			},
		});
		expect(createResult.isError).toBe(false);

		// Trigger the skill and verify the dependency warning appears
		await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "process data for me" });
		expect(getSystem()).toContain("You are a data processor");
		expect(getSystem()).toContain("Missing dependencies");
		expect(getSystem()).toContain("@nonexistent/bundle");

		// Clean up
		await callTool(runtime, "nb__manage_skill", {
			action: "delete",
			name: "dep-skill",
		});

		await runtime.shutdown();
	});

	it("validation rejects priority below 11", async () => {
		const workDir = join(testDir, "validation-reject");
		const { model } = createCapturingModel();

		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: model },
			noDefaultBundles: true,
			workDir,
			logging: { disabled: true },
			telemetry: { enabled: false },
		});
		await provisionTestWorkspace(runtime);

		// Attempt to create a skill with priority 5 (reserved range)
		const createResult = await callTool(runtime, "nb__manage_skill", {
			action: "create",
			name: "bad-priority",
			skill: {
				description: "Should be rejected",
				type: "skill",
				priority: 5,
				body: "This should never be saved.",
				triggers: ["bad priority"],
				keywords: ["bad", "priority"],
			},
		});
		expect(createResult.isError).toBe(true);
		// Schema-level validation at the InlineSource layer catches this before
		// the handler runs (schema declares minimum: 11).
		expect(createResult.content).toContain("priority");
		expect(createResult.content).toContain(">= 11");

		// Verify no file was created
		const skillFilePath = join(workDir, "skills", "bad-priority.md");
		expect(existsSync(skillFilePath)).toBe(false);

		// Verify it does not appear in status scope=skills
		const statusResult = await callTool(runtime, "nb__status", { scope: "skills" });
		expect(statusResult.content).not.toContain("bad-priority");

		await runtime.shutdown();
	});

});
