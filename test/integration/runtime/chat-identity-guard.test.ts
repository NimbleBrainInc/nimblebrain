/**
 * Tests: `runtime.chat()` identity guards (Stage 2 / T006).
 *
 * Stage 2 made the chat surface identity-bound, not workspace-bound. The
 * old `ChatRequest.workspaceId` field is gone — tools come from the
 * cross-workspace aggregator and each call routes via the orchestrator.
 * What this file pins is the remaining identity contract:
 *
 *   - When an auth provider is configured (`instance.json` exists),
 *     `runtime.chat()` MUST hard-error if `request.identity` is missing.
 *     A misconfigured production deployment (auth provider wired, auth
 *     middleware missing) would otherwise silently default every
 *     conversation to `usr_default`, bypassing single-owner.
 *   - In dev mode (no auth provider), the same call succeeds with the
 *     `DEV_IDENTITY` fallback (`usr_default`). The fallback is gated on
 *     `!this._identityProvider` so production can't silently degrade.
 *
 * Pre-Stage-2 this file also pinned "workspaceId is required" cases.
 * Those contracts are deleted (T006: "delete don't deprecate").
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";

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
// Auth configured — identity is the only guard left
// ---------------------------------------------------------------------------

describe("runtime.chat() with auth configured", () => {
  it("rejects chat without identity (auth provider configured)", async () => {
    const workDir = makeTempDir("no-identity");
    writeInstanceConfig(workDir);

    const runtime = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    try {
      await expect(runtime.chat({ message: "hello" })).rejects.toThrow(
        /no identity on request/,
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it("accepts chat with identity (no workspaceId required — Stage 2 T006)", async () => {
    const workDir = makeTempDir("identity-only");
    writeInstanceConfig(workDir);

    const runtime = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    try {
      const result = await runtime.chat({
        message: "hello",
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
  it("works with no identity (dev mode falls back to DEV_IDENTITY)", async () => {
    const workDir = makeTempDir("dev-no-identity");
    // No instance.json → dev mode

    const runtime = await Runtime.start({
      workDir,
      noDefaultBundles: true,
      model: { provider: "custom", adapter: createEchoModel() },
    });

    try {
      const result = await runtime.chat({ message: "hello dev" });
      expect(result.response).toBe("hello dev");
      expect(result.conversationId).toMatch(/^conv_/);
    } finally {
      await runtime.shutdown();
    }
  });
});
