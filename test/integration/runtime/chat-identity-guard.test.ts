/**
 * Tests: runtime.chat() identity and workspace guards.
 *
 * When an auth provider is configured (instance.json exists), runtime.chat()
 * must reject calls missing identity or workspaceId. In dev mode (no auth),
 * workspaceId is still required — there is no implicit fallback.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const testDirs: string[] = [];

function makeTempDir(label: string): string {
  const dir = join(tmpdir(), `nb-chat-guard-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  testDirs.push(dir);
  return dir;
}

/** Write a minimal instance.json to enable auth. */
function writeInstanceConfig(workDir: string): void {
  writeFileSync(
    join(workDir, "instance.json"),
    JSON.stringify({
      auth: {
        adapter: "oidc",
        issuer: "https://auth.example.com",
        clientId: "test",
        allowedDomains: ["example.com"],
      },
    }),
    "utf-8",
  );
}

afterAll(() => {
  for (const d of testDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Auth configured — guards enforce identity + workspace
// ---------------------------------------------------------------------------

describe("runtime.chat() with auth configured", () => {
  it("rejects chat without identity or workspaceId", async () => {
    const workDir = makeTempDir("no-identity");
    writeInstanceConfig(workDir);

    const runtime = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    try {
      // When auth is configured, workspaceId is checked first — missing workspace
      // rejects before identity can be validated
      await expect(
        runtime.chat({ message: "hello" }),
      ).rejects.toThrow("workspaceId is required");
    } finally {
      await runtime.shutdown();
    }
  });

  it("rejects chat with identity but no workspaceId", async () => {
    const workDir = makeTempDir("no-workspace");
    writeInstanceConfig(workDir);

    const runtime = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    try {
      await expect(
        runtime.chat({
          message: "hello",
          identity: {
            id: "usr_test",
            email: "test@example.com",
            displayName: "Test",
            orgRole: "member",
            preferences: {},
          },
        }),
      ).rejects.toThrow("workspaceId is required");
    } finally {
      await runtime.shutdown();
    }
  });

  it("accepts chat with both identity and workspaceId", async () => {
    const workDir = makeTempDir("full-ctx");
    writeInstanceConfig(workDir);

    const runtime = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    try {
      // Create workspace so the conversation directory exists and registry is provisioned
      const wsStore = runtime.getWorkspaceStore();
      const ws = await wsStore.create("Test Workspace");
      await runtime.ensureWorkspaceRegistry(ws.id);

      const result = await runtime.chat({
        message: "hello",
        workspaceId: ws.id,
        identity: {
          id: "usr_test",
          email: "test@example.com",
          displayName: "Test",
          orgRole: "member",
          preferences: {},
        },
      });

      expect(result.response).toBe("hello");
      expect(result.conversationId).toMatch(/^conv_/);
    } finally {
      await runtime.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// Dev mode (no auth) — DEV_IDENTITY fallback
// ---------------------------------------------------------------------------

describe("runtime.chat() in dev mode (no auth)", () => {
  it("works with explicit workspaceId and no identity", async () => {
    const workDir = makeTempDir("dev-explicit-ws");
    // No instance.json → dev mode

    const runtime = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    try {
      await provisionTestWorkspace(runtime);

      const result = await runtime.chat({
        message: "hello dev",
        workspaceId: TEST_WORKSPACE_ID,
      });
      expect(result.response).toBe("hello dev");
      expect(result.conversationId).toMatch(/^conv_/);
      expect(result.workspaceId).toBe(TEST_WORKSPACE_ID);
    } finally {
      await runtime.shutdown();
    }
  });

  it("throws when no workspaceId is provided even in dev mode", async () => {
    const workDir = makeTempDir("dev-no-ws");
    // No instance.json → dev mode

    const runtime = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    try {
      await expect(
        runtime.chat({ message: "no workspace" }),
      ).rejects.toThrow("workspaceId is required");
    } finally {
      await runtime.shutdown();
    }
  });
});
