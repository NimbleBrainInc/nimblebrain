import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";
import {
  resolveWorkspaceDisplayName,
  WorkspaceStore,
} from "../../src/workspace/workspace-store.ts";

// `resolveWorkspaceDisplayName` is the best-effort disk read that turns an
// opaque wsId into the human-readable name shown on a vendor's OAuth consent
// screen. File-IO only (no Runtime/server/spawn) → unit tier.

describe("resolveWorkspaceDisplayName", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-ws-name-test-"));
  });

  it("returns the workspace's human-readable name", async () => {
    const store = new WorkspaceStore(workDir);
    const ws = await store.create("Engineering Team");
    expect(await resolveWorkspaceDisplayName(workDir, ws.id)).toBe("Engineering Team");
  });

  it("returns undefined for an unknown workspace (caller falls back to the id)", async () => {
    expect(await resolveWorkspaceDisplayName(workDir, "ws_does_not_exist")).toBeUndefined();
  });

  it("returns undefined for a malformed workspace id rather than throwing", async () => {
    expect(await resolveWorkspaceDisplayName(workDir, "not-a-ws-id")).toBeUndefined();
  });
});
