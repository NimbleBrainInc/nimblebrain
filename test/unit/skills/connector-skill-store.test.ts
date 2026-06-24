import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeConnectorSkill,
  readConnectorSkillCandidates,
  removeConnectorSkillsForServer,
} from "../../../src/skills/connector-skill-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cskstore-"));
  dirs.push(d);
  return d;
}

const OVERLAY = `---
name: gmail-usage
description: How to use the Gmail connector
metadata:
  nimblebrain:
    loading-strategy: always
    priority: 30
---

Confirm the recipient before calling gmail__send.
`;

describe("materializeConnectorSkill", () => {
  it("writes <server>/<skill>.md and re-stamps runtime fields + connector provenance", () => {
    const root = tmp();
    const res = materializeConnectorSkill({
      connectorSkillsDir: root,
      serverName: "gmail",
      overlayBody: OVERLAY,
      source: "connector:composio/gmail@v0.1.0",
      now: "2026-01-01T00:00:00.000Z",
    });

    expect(res).not.toBeNull();
    expect(res!.skillName).toBe("gmail-usage");
    expect(res!.path).toBe(join(root, "gmail", "gmail-usage.md"));
    expect(existsSync(res!.path)).toBe(true);

    const written = readFileSync(res!.path, "utf-8");
    // Runtime fields are re-stamped regardless of what the overlay author declared:
    // dynamic loading + tool-affinity bound to THIS install's namespace.
    expect(written).toContain("loading-strategy: dynamic");
    expect(written).toContain("gmail__*");
    expect(written).toContain("origin: connector");
    expect(written).toContain("connector:composio/gmail@v0.1.0");
    // The author's `always` strategy did NOT survive.
    expect(written).not.toContain("loading-strategy: always");
  });

  it("returns null on an unparseable overlay (non-fatal to the caller)", () => {
    const root = tmp();
    const res = materializeConnectorSkill({
      connectorSkillsDir: root,
      serverName: "gmail",
      overlayBody: "no frontmatter, just prose",
      source: "connector:composio/gmail@v0.1.0",
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(res).toBeNull();
  });
});

describe("readConnectorSkillCandidates", () => {
  it("returns [] for a missing dir", () => {
    expect(readConnectorSkillCandidates(join(tmp(), "nope"))).toEqual([]);
  });

  it("loads materialized overlays as candidates scoped 'connector' with tool-affinity", () => {
    const root = tmp();
    materializeConnectorSkill({
      connectorSkillsDir: root,
      serverName: "gmail",
      overlayBody: OVERLAY,
      source: "connector:composio/gmail@v0.1.0",
      now: "2026-01-01T00:00:00.000Z",
    });

    const candidates = readConnectorSkillCandidates(root);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe("gmail-usage");
    expect(candidates[0]!.scope).toBe("connector");
    expect(candidates[0]!.toolAffinity).toEqual(["gmail__*"]);
    expect(candidates[0]!.body).toContain("Confirm the recipient");
  });
});

describe("removeConnectorSkillsForServer", () => {
  it("deletes the server's overlays and the now-empty dir", () => {
    const root = tmp();
    materializeConnectorSkill({
      connectorSkillsDir: root,
      serverName: "gmail",
      overlayBody: OVERLAY,
      source: "connector:composio/gmail@v0.1.0",
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(existsSync(join(root, "gmail"))).toBe(true);

    removeConnectorSkillsForServer(root, "gmail");
    expect(existsSync(join(root, "gmail"))).toBe(false);
    expect(readConnectorSkillCandidates(root)).toEqual([]);

    // Idempotent — removing an absent server is a no-op.
    expect(() => removeConnectorSkillsForServer(root, "gmail")).not.toThrow();
  });
});
