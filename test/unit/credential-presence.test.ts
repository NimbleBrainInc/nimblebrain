/**
 * `connectorHasCredential` — the one answer the re-connect gate and the UI's
 * `hasCredential` both read.
 *
 * The rule that matters here is *what it keys on*: the stored ref, never the
 * catalog. A brokered connector keeps its credential under the provider's
 * layout, and the catalog can be renamed, removed, or simply unavailable when
 * a registry fetch fails. Keying on the catalog makes such a connector probe
 * the DCR layout, find nothing, report "no credential" — and that reads as a
 * first connect, which skips the gate entirely.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composioConnectionPath } from "../../src/bundles/composio-connection.ts";
import { connectorHasCredential } from "../../src/bundles/credential-presence.ts";
import type { BundleRef } from "../../src/bundles/types.ts";
import { mcpOAuthDir } from "../../src/tools/workspace-oauth-provider.ts";

const WS_ID = "ws_test";
const OWNER = { type: "workspace", wsId: WS_ID } as const;
const SERVER = "gmail";
const CONNECTOR_ID = "com.google/gmail";

const COMPOSIO_REF = {
  url: "https://mcp.composio.test/gmail",
  composio: { connectorId: CONNECTOR_ID },
} as unknown as BundleRef;
const DCR_REF = { url: "https://mcp.granola.test/mcp" } as unknown as BundleRef;

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-cred-presence-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function seedComposio(): void {
  const file = composioConnectionPath(workDir, OWNER, CONNECTOR_ID);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ connectedAccountId: "ca_1" }));
}

function seedDcrTokens(): void {
  const dir = mcpOAuthDir(workDir, OWNER, SERVER);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tokens.json"), JSON.stringify({ access_token: "t" }));
}

describe("connectorHasCredential — DCR connectors", () => {
  test("no tokens → no credential", () => {
    expect(connectorHasCredential(workDir, OWNER, SERVER, DCR_REF)).toBe(false);
  });

  test("tokens on disk → credential", () => {
    seedDcrTokens();
    expect(connectorHasCredential(workDir, OWNER, SERVER, DCR_REF)).toBe(true);
  });

  test("an absent ref is treated as DCR", () => {
    // Named/local bundles carry no ref; they have no brokered layout to check.
    seedDcrTokens();
    expect(connectorHasCredential(workDir, OWNER, SERVER, undefined)).toBe(true);
  });
});

describe("connectorHasCredential — brokered connectors", () => {
  test("a composio connection is found via the ref, with no catalog involved", () => {
    // The regression this guards: keying on the catalog instead would probe the
    // DCR layout here, find nothing, and skip the gate.
    seedComposio();
    expect(connectorHasCredential(workDir, OWNER, SERVER, COMPOSIO_REF)).toBe(true);
  });

  test("a composio connector with no connection reads as a first connect", () => {
    expect(connectorHasCredential(workDir, OWNER, SERVER, COMPOSIO_REF)).toBe(false);
  });

  test("a composio connector does NOT answer from stray DCR tokens", () => {
    // Wrong-layout leakage in the other direction: tokens under the server name
    // must not make a brokered connector look connected.
    seedDcrTokens();
    expect(connectorHasCredential(workDir, OWNER, SERVER, COMPOSIO_REF)).toBe(false);
  });

  test("a brokered provider with no credential layout answers false", () => {
    // smithery is broker-credentialed — it persists nothing locally, so there
    // is nothing to replace and nothing to gate.
    const smithery = {
      url: "https://mcp.smithery.test/x",
      smithery: { connectorId: "acme/thing" },
    } as unknown as BundleRef;
    seedDcrTokens();
    expect(connectorHasCredential(workDir, OWNER, SERVER, smithery)).toBe(false);
  });
});

describe("connectorHasCredential — owner isolation", () => {
  test("another workspace's credential does not answer for this one", () => {
    const other = { type: "workspace", wsId: "ws_other" } as const;
    const dir = mcpOAuthDir(workDir, other, SERVER);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tokens.json"), JSON.stringify({ access_token: "t" }));
    expect(connectorHasCredential(workDir, OWNER, SERVER, DCR_REF)).toBe(false);
  });
});
