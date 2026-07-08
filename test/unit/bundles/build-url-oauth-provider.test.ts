import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUrlOAuthProvider } from "../../../src/bundles/startup.ts";
import type { BundleRef } from "../../../src/bundles/types.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";

/**
 * The owner dimension of the URL-bundle OAuth provider builder. A personal
 * connector installs with an `identityOwner`, which must produce the
 * `{type:"user"}` provider (credentials under `users/<id>/...`, no workspace)
 * — the identity arm of the same start path — while the existing workspace
 * path is untouched.
 */

const noop = (): void => {};

function urlRef(extra: Partial<Extract<BundleRef, { url: string }>> = {}): Extract<
  BundleRef,
  { url: string }
> {
  return { url: "https://mcp.example.com/granola", serverName: "granola", ui: null, ...extra };
}

describe("buildUrlOAuthProvider — owner dimension", () => {
  it('identityOwner → a {type:"user"} provider whose tokens land under users/<id>/', async () => {
    const workDir = mkdtempSync(join(tmpdir(), "nb-buop-user-"));
    const provider = await buildUrlOAuthProvider(
      urlRef(),
      "granola",
      undefined,
      { identityOwner: { userId: "usr_alice" }, workDir },
      noop,
    );
    expect(provider).toBeDefined();
    expect(provider?.getOwner()).toEqual({ type: "user", userId: "usr_alice" });

    // The credential root is the identity plane, not any workspace.
    await provider?.saveTokens({ access_token: "t", token_type: "Bearer" });
    const path = join(
      workDir,
      "users",
      "usr_alice",
      "credentials",
      "mcp-oauth",
      "granola",
      "tokens.json",
    );
    expect(JSON.parse(readFileSync(path, "utf-8"))).toMatchObject({ access_token: "t" });
  });

  it('workspace context (no identityOwner) → a {type:"workspace"} provider (path unchanged)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), "nb-buop-ws-"));
    const provider = await buildUrlOAuthProvider(
      urlRef(),
      "granola",
      new WorkspaceContext({ wsId: "ws_test", workDir }),
      { allowInsecureRemotes: true },
      noop,
    );
    expect(provider?.getOwner()).toEqual({ type: "workspace", wsId: "ws_test" });
  });

  it("identityOwner takes precedence — a stray wsContext can't bind a personal connector to a workspace", async () => {
    // The two are mutually exclusive by contract; this pins that the identity
    // branch is evaluated first, so ownership can never silently fall through
    // to the workspace.
    const workDir = mkdtempSync(join(tmpdir(), "nb-buop-prec-"));
    const provider = await buildUrlOAuthProvider(
      urlRef(),
      "granola",
      new WorkspaceContext({ wsId: "ws_test", workDir }),
      { identityOwner: { userId: "usr_alice" }, workDir },
      noop,
    );
    expect(provider?.getOwner()).toEqual({ type: "user", userId: "usr_alice" });
  });
});
