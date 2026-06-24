import { describe, expect, it, afterAll } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createMockModel, runtimeContextHead } from "../helpers/mock-model.ts";
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
				capturedSystem = systemMsg.content + runtimeContextHead(options.prompt);
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
		{ identity: null, scope: { kind: "workspace", workspaceId: TEST_WORKSPACE_ID, workspaceAgents: null, workspaceModelOverride: null } },
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

		// 1. Create an org-tier dynamic skill (trigger-matchable) via skills__create
		const createResult = await callTool(runtime, "skills__create", {
			scope: "org",
			manifest: {
				name: "test-greeter",
				description: "Greets people warmly",
				loadingStrategy: "dynamic",
				priority: 50,
				triggers: ["greet someone", "say hello"],
			},
			body: "You are a warm and friendly greeter. Always say hello enthusiastically.",
		});
		expect(createResult.isError).toBe(false);
		expect(createResult.content).toContain("test-greeter");

		// 2. Verify it appears in nb__status scope=skills output
		const statusResult = await callTool(runtime, "nb__status", { scope: "skills" });
		expect(statusResult.isError).toBe(false);
		expect(statusResult.content).toContain("test-greeter");

		// 3. Verify the skill matcher matches it when given a message with its trigger
		const chatResult = await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "greet someone please" });
		expect(chatResult.skillName).toBe("test-greeter");

		// 4. Verify the skill body appears in composed system prompt
		expect(getSystem()).toContain("warm and friendly greeter");

		// 5. Delete it via skills__delete (id = full path)
		const skillPath = join(workDir, "skills", "test-greeter.md");
		const deleteResult = await callTool(runtime, "skills__delete", { id: skillPath });
		expect(deleteResult.isError).toBe(false);
		expect(deleteResult.content).toContain("test-greeter");

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

		// Create an always-on context skill with priority 20 (above core threshold of 10)
		const createResult = await callTool(runtime, "skills__create", {
			scope: "org",
			manifest: {
				name: "team-context",
				description: "Team-specific context",
				loadingStrategy: "always",
				priority: 20,
			},
			body: "You are working for Acme Corp. Always mention the company name.",
		});
		expect(createResult.isError).toBe(false);

		// Send a message with NO trigger match — context skill should still appear
		await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "what is 2 + 2" });
		expect(getSystem()).toContain("Acme Corp");

		// Send a completely different message — context skill should still be present
		await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "tell me about the weather" });
		expect(getSystem()).toContain("Acme Corp");

		// Delete and verify removal
		const skillPath = join(workDir, "skills", "team-context.md");
		const deleteResult = await callTool(runtime, "skills__delete", { id: skillPath });
		expect(deleteResult.isError).toBe(false);

		await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "anything at all" });
		expect(getSystem()).not.toContain("Acme Corp");

		await runtime.shutdown();
	});

	it("skills__update on a bare/garbage id returns the unrecognized-id error, not the bundle error", async () => {
		// Regression: scopeOfPath used to fall through to "bundle" for any
		// path that didn't sit under workspaces/users/skills. That meant
		// passing a bare name like "dl-production-memory" got back the
		// misleading "Bundle (Layer 1) skills are vendored" error, which
		// pointed agents at the wrong fix path. After the fix, scopeOfPath
		// returns null for unclassified inputs and the handler errors with
		// a clear message describing the real input contract.
		const workDir = join(testDir, "garbage-id");
		const { model } = createCapturingModel();
		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: model },
			noDefaultBundles: true,
			workDir,
			logging: { disabled: true },
			telemetry: { enabled: false },
		});
		await provisionTestWorkspace(runtime);

		for (const id of [
			"dl-production-memory",
			"org/dl-production-memory",
			"workspace/voice-rules.md",
			"some-random-name",
		]) {
			const r = await callTool(runtime, "skills__update", { id, body: "test" });
			expect(r.isError).toBe(true);
			expect(r.content).toContain("not a recognized form");
			expect(r.content).not.toContain("Bundle (Layer 1)");
		}

		await runtime.shutdown();
	});

	it("skills__list textContent includes per-skill rows with ids", async () => {
		// Regression: summarizeList used to emit only counts ("12 skills
		// (12 org)"). Agents couldn't enumerate ids from text and were
		// forced to guess paths. textContent now includes one row per
		// skill so an LLM consumer can copy ids directly.
		const workDir = join(testDir, "list-rows");
		const { model } = createCapturingModel();
		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: model },
			noDefaultBundles: true,
			workDir,
			logging: { disabled: true },
			telemetry: { enabled: false },
		});
		await provisionTestWorkspace(runtime);

		await callTool(runtime, "skills__create", {
			scope: "org",
			manifest: {
				name: "row-fixture",
				description: "Fixture for list-rows test",
				loadingStrategy: "dynamic",
				priority: 50,
			},
			body: "Body.",
		});

		const list = await callTool(runtime, "skills__list", { scope: "org" });
		expect(list.isError).toBe(false);
		// Header still summarizes (count + scope breakdown).
		expect(list.content).toMatch(/skill[s]? \(\d+ org/);
		// Plus one row per skill, with the absolute path id and meta tags.
		expect(list.content).toContain("row-fixture.md");
		expect(list.content).toContain("(L3 org");

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

		// Attempt to create a skill with priority 5 (reserved range — the
		// validator rejects below 11 for non-core skills).
		const createResult = await callTool(runtime, "skills__create", {
			scope: "org",
			manifest: {
				name: "bad-priority",
				description: "Should be rejected",
				loadingStrategy: "dynamic",
				priority: 5,
				triggers: ["bad priority"],
			},
			body: "This should never be saved.",
		});
		expect(createResult.isError).toBe(true);
		// Rejected up front by the input schema (priority minimum 11) — earlier than
		// the handler's validateSkill, and consistent with the canonical bound.
		expect(createResult.content).toContain("must be >= 11");

		// Verify no file was created
		const skillFilePath = join(workDir, "skills", "bad-priority.md");
		expect(existsSync(skillFilePath)).toBe(false);

		// Verify it does not appear in status scope=skills
		const statusResult = await callTool(runtime, "nb__status", { scope: "skills" });
		expect(statusResult.content).not.toContain("bad-priority");

		await runtime.shutdown();
	});

});
