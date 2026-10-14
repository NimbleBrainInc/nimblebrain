/**
 * Tests: `runtime.chat()` identity guards.
 *
 * `runtime.chat()` MUST hard-error if `request.identity` is missing, under
 * every identity provider, `dev` included. A deployment whose auth
 * middleware was missing, or an in-process caller that forgot the identity,
 * would otherwise default every conversation to `usr_default`, bypassing
 * single-owner. Under `dev`, the caller passes the dev identity like any other.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { devProvider, devWorkspace } from "../../helpers/dev-provider.ts";
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
      languageModel: createEchoModel(),
    });

    try {
      await expect(runtime.chat({ message: "hello" })).rejects.toThrow(/no identity on request/);
    } finally {
      await runtime.shutdown();
    }
  });

  it("refuses a chat with identity that names no workspace (the server picks none)", async () => {
    const workDir = makeTempDir("identity-only");
    writeInstanceConfig(workDir);

    const runtime = await Runtime.start({
      workDir,
      languageModel: createEchoModel(),
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
      ).rejects.toThrow("request names no workspace");
    } finally {
      await runtime.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// The dev identity provider — no fallback to the dev user
// ---------------------------------------------------------------------------

describe("runtime.chat() under the dev identity provider", () => {
  it("rejects chat without identity, as under any provider", async () => {
    const workDir = makeTempDir("dev-no-identity");
    const runtime = await Runtime.start({
      identityProvider: devProvider,
      workDir,
      languageModel: createEchoModel(),
    });

    try {
      await expect(
        runtime.chat({ message: "hello dev", workspaceId: await devWorkspace(runtime) }),
      ).rejects.toThrow("no identity on request");
    } finally {
      await runtime.shutdown();
    }
  });

  it("chats as the dev user when the caller passes the dev identity", async () => {
    const workDir = makeTempDir("dev-identity");
    const runtime = await Runtime.start({
      identityProvider: devProvider,
      workDir,
      languageModel: createEchoModel(),
    });

    try {
      const result = await runtime.chat({
        identity: DEV_IDENTITY,
        message: "hello dev",
        workspaceId: await devWorkspace(runtime),
      });
      expect(result.response).toBe("hello dev");
      expect(result.conversationId).toMatch(/^conv_/);
    } finally {
      await runtime.shutdown();
    }
  });
});
