import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composioConnectionPath,
  composioConnectorDir,
  connectorSlug,
  hasPersistedComposioConnection,
  readComposioConnection,
  saveComposioConnection,
} from "../../src/bundles/composio-connection.ts";

function freshDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nb-composio-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const SAMPLE = {
  connectedAccountId: "ca_test_123",
  toolkit: "gmail",
  userId: "hq:ws_01abc",
  connectedAt: "2026-05-12T00:00:00.000Z",
  status: "ACTIVE",
};

describe("connectorSlug", () => {
  test("slugs reverse-DNS connector ids with slashes", () => {
    expect(connectorSlug("com.google/gmail")).toBe("com.google-gmail");
  });

  test("strips a leading @ scope prefix", () => {
    expect(connectorSlug("@vendor/toolkit")).toBe("vendor-toolkit");
  });

  test("rejects literal `.` and `..` segments (filesystem traversal markers)", () => {
    expect(() => connectorSlug("..")).toThrow();
    expect(() => connectorSlug(".")).toThrow();
  });

  test("disarms path-traversal input by collapsing slashes to dashes", () => {
    // `../escape` becomes `..-escape` after slash collapse — a valid
    // filename that can't traverse out of the credentials directory.
    // Mirrors the bundleSlug semantics in workspace-credentials.ts.
    expect(connectorSlug("../escape")).toBe("..-escape");
  });

  test("rejects shell-hostile characters", () => {
    expect(() => connectorSlug("a;b")).toThrow();
    expect(() => connectorSlug("a$b")).toThrow();
    expect(() => connectorSlug("a b")).toThrow();
  });

  test("rejects empty / non-string input", () => {
    expect(() => connectorSlug("")).toThrow();
    expect(() => connectorSlug(undefined as unknown as string)).toThrow();
  });
});

describe("composioConnectorDir + composioConnectionPath", () => {
  test("builds the expected path under workspaces/<ws>/credentials/composio/<connectorSlug>/", () => {
    const dir = composioConnectorDir("/work", "ws_test", "com.google/gmail");
    expect(dir).toBe("/work/workspaces/ws_test/credentials/composio/com.google-gmail");
    const file = composioConnectionPath("/work", "ws_test", "com.google/gmail");
    expect(file).toBe(
      "/work/workspaces/ws_test/credentials/composio/com.google-gmail/connection.json",
    );
  });

  test("rejects path-traversal wsId before constructing any path", () => {
    expect(() => composioConnectorDir("/work", "../escape", "com.google/gmail")).toThrow();
  });
});

describe("saveComposioConnection", () => {
  test("writes connection.json atomically with 0o600 under a 0o700 dir", async () => {
    const { dir, cleanup } = freshDir();
    try {
      await saveComposioConnection(dir, "ws_test", "com.google/gmail", SAMPLE);
      const path = composioConnectionPath(dir, "ws_test", "com.google/gmail");
      const fileStat = statSync(path);
      expect(fileStat.mode & 0o777).toBe(0o600);
      const dirStat = statSync(composioConnectorDir(dir, "ws_test", "com.google/gmail"));
      expect(dirStat.mode & 0o777).toBe(0o700);
      const content = JSON.parse(await readFile(path, "utf-8"));
      expect(content).toEqual(SAMPLE);
    } finally {
      cleanup();
    }
  });

  test("replaces an existing connection.json (latest write wins)", async () => {
    const { dir, cleanup } = freshDir();
    try {
      await saveComposioConnection(dir, "ws_test", "com.google/gmail", SAMPLE);
      const updated = { ...SAMPLE, connectedAccountId: "ca_second", status: "INACTIVE" };
      await saveComposioConnection(dir, "ws_test", "com.google/gmail", updated);
      const readBack = await readComposioConnection(dir, "ws_test", "com.google/gmail");
      expect(readBack).toEqual(updated);
    } finally {
      cleanup();
    }
  });
});

describe("readComposioConnection", () => {
  test("returns null when no file exists", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const result = await readComposioConnection(dir, "ws_test", "com.google/gmail");
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("throws when the file is not JSON", async () => {
    const { dir, cleanup } = freshDir();
    try {
      // Seed with an invalid file by reaching past the public API.
      await saveComposioConnection(dir, "ws_test", "com.google/gmail", SAMPLE);
      const path = composioConnectionPath(dir, "ws_test", "com.google/gmail");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, "not-json");
      await expect(readComposioConnection(dir, "ws_test", "com.google/gmail")).rejects.toThrow();
    } finally {
      cleanup();
    }
  });

  test("throws when required fields are missing", async () => {
    const { dir, cleanup } = freshDir();
    try {
      await saveComposioConnection(dir, "ws_test", "com.google/gmail", SAMPLE);
      const path = composioConnectionPath(dir, "ws_test", "com.google/gmail");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, JSON.stringify({ connectedAccountId: "ca_x" }));
      await expect(readComposioConnection(dir, "ws_test", "com.google/gmail")).rejects.toThrow(
        /missing required field/,
      );
    } finally {
      cleanup();
    }
  });
});

describe("hasPersistedComposioConnection", () => {
  test("true after save, false otherwise", async () => {
    const { dir, cleanup } = freshDir();
    try {
      expect(hasPersistedComposioConnection(dir, "ws_test", "com.google/gmail")).toBe(false);
      await saveComposioConnection(dir, "ws_test", "com.google/gmail", SAMPLE);
      expect(hasPersistedComposioConnection(dir, "ws_test", "com.google/gmail")).toBe(true);
    } finally {
      cleanup();
    }
  });
});
