/**
 * Skill catalog builder — pure-function tests.
 *
 * Verifies:
 *   - Deterministic output: sorted by name (codepoint order), deduplicated
 *     with filesystem > bundle > connector precedence.
 *   - Disabled skills never enter the catalog.
 *   - Connector candidates contribute name/description/body/scope.
 *   - `toCatalogEntries` projects name+description only (no body, no state).
 *   - Workspace wall at the pool boundary: the catalog contains exactly what
 *     the workspace-scoped loader returned — a skill on disk in another
 *     workspace's dir never appears.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ConnectorSkillCandidate } from "../../../src/engine/types.ts";
import { collectActivatableSkills, toCatalogEntries } from "../../../src/skills/catalog.ts";
import { loadScopedSkills } from "../../../src/skills/loader.ts";
import type { Skill } from "../../../src/skills/types.ts";

function dynamicSkill(
  name: string,
  overrides: Partial<Skill["manifest"]> = {},
  body = `Body for ${name}.`,
): Skill {
  return {
    manifest: {
      name,
      description: `${name} description`,
      loadingStrategy: "dynamic",
      priority: 50,
      status: "active",
      ...overrides,
    },
    body,
    sourcePath: `/test/${name}.md`,
  };
}

function candidate(name: string, description?: string): ConnectorSkillCandidate {
  return {
    name,
    ...(description ? { description } : {}),
    body: `Overlay body for ${name}.`,
    scope: "connector",
    toolAffinity: [`${name}__*`],
  };
}

describe("collectActivatableSkills", () => {
  test("merges all three pools sorted by name", () => {
    const out = collectActivatableSkills({
      fsCapability: [dynamicSkill("zeta", { scope: "workspace" })],
      bundleCapability: [dynamicSkill("alpha", { scope: "bundle" })],
      connectorCandidates: [candidate("mid", "curated overlay")],
    });
    expect(out.map((s) => s.name)).toEqual(["alpha", "mid", "zeta"]);
    expect(out[0]!.scope).toBe("bundle");
    expect(out[1]!.scope).toBe("connector");
    expect(out[1]!.description).toBe("curated overlay");
    expect(out[2]!.scope).toBe("workspace");
  });

  test("drops disabled skills — the catalog must not offer a muted skill", () => {
    const out = collectActivatableSkills({
      fsCapability: [dynamicSkill("live"), dynamicSkill("muted", { status: "disabled" })],
      bundleCapability: [],
      connectorCandidates: [],
    });
    expect(out.map((s) => s.name)).toEqual(["live"]);
  });

  test("dedupes by name with filesystem > bundle > connector precedence", () => {
    const out = collectActivatableSkills({
      fsCapability: [dynamicSkill("shared", { scope: "user" }, "fs body")],
      bundleCapability: [dynamicSkill("shared", { scope: "bundle" }, "bundle body")],
      connectorCandidates: [candidate("shared")],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.scope).toBe("user");
    expect(out[0]!.body).toBe("fs body");
  });

  test("sort is codepoint order — stable regardless of locale collation", () => {
    const out = collectActivatableSkills({
      fsCapability: [dynamicSkill("b-skill"), dynamicSkill("a-skill"), dynamicSkill("ab-skill")],
      bundleCapability: [],
      connectorCandidates: [],
    });
    expect(out.map((s) => s.name)).toEqual(["a-skill", "ab-skill", "b-skill"]);
  });

  test("empty pools produce an empty catalog", () => {
    expect(
      collectActivatableSkills({ fsCapability: [], bundleCapability: [], connectorCandidates: [] }),
    ).toEqual([]);
  });
});

describe("toCatalogEntries", () => {
  test("projects name + description only — never body or load state", () => {
    const entries = toCatalogEntries(
      collectActivatableSkills({
        fsCapability: [dynamicSkill("with-desc"), dynamicSkill("bare", { description: "" })],
        bundleCapability: [],
        connectorCandidates: [],
      }),
    );
    expect(entries).toEqual([
      { name: "bare" },
      { name: "with-desc", description: "with-desc description" },
    ]);
  });
});

describe("workspace wall — catalog contains only the scoped loader's output", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skill-catalog-wall-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeDynamicSkill(dir: string, name: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${name}.md`),
      `---\nname: ${name}\ndescription: ${name} description\nmetadata:\n  nimblebrain:\n    loading-strategy: dynamic\n---\nBody for ${name}.\n`,
      "utf-8",
    );
  }

  test("a skill in another workspace's dir does not appear", () => {
    // Two workspaces' skill dirs on disk; the catalog is built from ONE
    // workspace's scoped read — the same per-workspace dir
    // `loadConversationSkills` resolves — so ws_b's skill can't leak in.
    const wsADir = join(root, "workspaces", "ws_a", "skills");
    const wsBDir = join(root, "workspaces", "ws_b", "skills");
    writeDynamicSkill(wsADir, "mine");
    writeDynamicSkill(wsBDir, "theirs");

    const entries = toCatalogEntries(
      collectActivatableSkills({
        fsCapability: loadScopedSkills(wsADir, "workspace"),
        bundleCapability: [],
        connectorCandidates: [],
      }),
    );
    expect(entries.map((e) => e.name)).toEqual(["mine"]);
  });
});
