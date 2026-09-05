import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUrlOAuthProvider } from "../../../src/bundles/startup.ts";
import type { BundleRef } from "../../../src/bundles/types.ts";
import { mcpOAuthKey } from "../../../src/tools/mcp-oauth-records.ts";
import { WorkspaceContext } from "../../../src/workspace/context.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../../helpers/credential-store.ts";

/**
 * The owner dimension of the URL-bundle OAuth provider builder. A personal
 * connector installs with an `identityOwner`, which must produce the
 * `{type:"user"}` provider (credentials at user scope, no workspace) — the
 * identity arm of the same start path — while the existing workspace path is
 * untouched.
 */

afterEach(() => {
  resetTestCredentialStore();
});

const noop = (): void => {};

function urlRef(extra: Partial<Extract<BundleRef, { url: string }>> = {}): Extract<
  BundleRef,
  { url: string }
> {
  return { url: "https://mcp.example.com/granola", serverName: "granola", ui: null, ...extra };
}

describe("buildUrlOAuthProvider — owner dimension", () => {
  it('identityOwner → a {type:"user"} provider whose tokens land at user scope', async () => {
    const workDir = mkdtempSync(join(tmpdir(), "nb-buop-user-"));
    const store = installTestCredentialStore(workDir);
    const provider = await buildUrlOAuthProvider(
      urlRef(),
      "granola",
      undefined,
      { identityOwner: { userId: "usr_alice" }, workDir },
      noop,
    );
    expect(provider).toBeDefined();
    expect(provider?.getOwner()).toEqual({ type: "user", userId: "usr_alice" });

    // The credential scope is the identity plane, not any workspace.
    await provider?.saveTokens({ access_token: "t", token_type: "Bearer" });
    const stored = await store.get(
      { kind: "user", userId: "usr_alice" },
      mcpOAuthKey("granola", "tokens"),
      { caller: "test", purpose: "assert" },
    );
    expect(JSON.parse(stored?.reveal() ?? "null")).toMatchObject({ access_token: "t" });
  });

  it('workspace context (no identityOwner) → a {type:"workspace"} provider (path unchanged)', async () => {
    const workDir = mkdtempSync(join(tmpdir(), "nb-buop-ws-"));
    installTestCredentialStore(workDir);
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
    installTestCredentialStore(workDir);
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
