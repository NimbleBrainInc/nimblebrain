import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasPersistedWorkspaceOAuthTokens,
  workspaceOAuthDir,
} from "../../src/bundles/oauth-tokens.ts";

function freshDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nb-oauth-tokens-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("hasPersistedWorkspaceOAuthTokens", () => {
  test("returns true when tokens.json exists at the expected path", () => {
    const { dir, cleanup } = freshDir();
    try {
      const tokensDir = workspaceOAuthDir(dir, "ws_test", "granola");
      mkdirSync(tokensDir, { recursive: true });
      writeFileSync(join(tokensDir, "tokens.json"), "{}");
      expect(hasPersistedWorkspaceOAuthTokens(dir, "ws_test", "granola")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("returns false when the credentials directory doesn't exist", () => {
    const { dir, cleanup } = freshDir();
    try {
      expect(hasPersistedWorkspaceOAuthTokens(dir, "ws_test", "granola")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("returns false when the dir exists but tokens.json is absent", () => {
    const { dir, cleanup } = freshDir();
    try {
      const tokensDir = workspaceOAuthDir(dir, "ws_test", "granola");
      mkdirSync(tokensDir, { recursive: true });
      // Sibling files (client.json, verifier.json) shouldn't be mistaken
      // for a tokens.json — the probe is specifically for the post-OAuth
      // state where tokens have been persisted.
      writeFileSync(join(tokensDir, "client.json"), "{}");
      expect(hasPersistedWorkspaceOAuthTokens(dir, "ws_test", "granola")).toBe(false);
    } finally {
      cleanup();
    }
  });
});
