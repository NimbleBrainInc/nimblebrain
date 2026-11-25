import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContractDefinition,
  type ContractRegistry,
  checkContracts,
  implementationProblem,
  loadContracts,
  parseContractDefinition,
  versionMeets,
} from "../../../src/plugins/contracts.ts";

const SINGLETON: ContractDefinition = {
  id: "ai.example.records",
  version: "1.2",
  cardinality: "singleton",
  privateTools: ["append"],
};
const ADDITIVE: ContractDefinition = {
  id: "ai.example.tools",
  version: "1.0",
  cardinality: "additive",
  privateTools: [],
};
const REGISTRY: ContractRegistry = new Map([
  [SINGLETON.id, SINGLETON],
  [ADDITIVE.id, ADDITIVE],
]);

/** A contract document, as `schemas/contracts/<name>/v<major>/contract.json` holds it. */
function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $id: "https://schemas.example/contracts/records/v1/contract.json",
    contract: "ai.example.records",
    version: "1.2",
    cardinality: "singleton",
    tools: { list: { visibility: "public" }, append: { visibility: "private" } },
    errors: { public: [], private: [] },
    $defs: {},
    ...over,
  };
}

const records = (version = "1.2") => ({ contract: SINGLETON.id, version, server: "store" });
const tools = { contract: ADDITIVE.id, version: "1.0", server: "app" };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeDoc(dir: string, name: string, major: string, body: unknown): void {
  mkdirSync(join(dir, name, major), { recursive: true });
  writeFileSync(join(dir, name, major, "contract.json"), JSON.stringify(body));
}

describe("loadContracts", () => {
  test("reads the repository's contract documents: conversations today", () => {
    const conversations = loadContracts().get("ai.nimblebrain.conversations");
    expect(conversations).toMatchObject({ version: "1.1", cardinality: "singleton" });
    expect(conversations?.privateTools.sort()).toEqual([
      "append_events",
      "create",
      "create_workspace",
      "delete",
      "delete_workspace",
      "events",
    ]);
  });

  test("reads <name>/v<major>/contract.json, and refuses a major the version does not state", () => {
    const dir = mkdtempSync(join(tmpdir(), "contracts-"));
    dirs.push(dir);
    writeDoc(dir, "records", "v1", doc());
    mkdirSync(join(dir, "notes", "drafts"), { recursive: true });
    expect([...loadContracts(dir).keys()]).toEqual(["ai.example.records"]);

    writeDoc(dir, "other", "v2", doc({ contract: "ai.example.other" }));
    expect(() => loadContracts(dir)).toThrow(/version 1\.2 is not major v2/);
  });

  test("refuses a contract two documents name", () => {
    const dir = mkdtempSync(join(tmpdir(), "contracts-"));
    dirs.push(dir);
    writeDoc(dir, "a", "v1", doc());
    writeDoc(dir, "b", "v1", doc());
    expect(() => loadContracts(dir)).toThrow(/defined twice/);
  });

  test("a missing directory is an empty registry", () => {
    expect(loadContracts(join(tmpdir(), "no-such-contracts-dir")).size).toBe(0);
  });
});

describe("parseContractDefinition", () => {
  test("reads the name, version, cardinality and private tools", () => {
    expect(parseContractDefinition(doc(), "c.json")).toEqual(SINGLETON);
  });

  test("names the file and the field it refuses", () => {
    expect(() => parseContractDefinition(doc({ contract: "Records" }), "c.json")).toThrow(
      "c.json: contract must be a reverse-DNS name",
    );
    expect(() => parseContractDefinition(doc({ version: "1" }), "c.json")).toThrow(
      'c.json: version must be "major.minor"',
    );
    expect(() => parseContractDefinition(doc({ cardinality: "many" }), "c.json")).toThrow(
      /cardinality/,
    );
    expect(() => parseContractDefinition(doc({ tools: {} }), "c.json")).toThrow(/tools/);
    expect(() =>
      parseContractDefinition(doc({ tools: { list: { visibility: "secret" } } }), "c.json"),
    ).toThrow("c.json: tools.list.visibility");
  });
});

describe("versionMeets", () => {
  test("same major, minor at least the one needed", () => {
    expect(versionMeets("1.2", "1.2")).toBe(true);
    expect(versionMeets("1.3", "1.2")).toBe(true);
    expect(versionMeets("1.1", "1.2")).toBe(false);
    expect(versionMeets("2.0", "1.0")).toBe(false);
    expect(versionMeets("0.9", "1.0")).toBe(false);
    expect(versionMeets("1", "1.0")).toBe(false);
  });
});

describe("implementationProblem", () => {
  test("holds an implementation to the version this runtime consumes", () => {
    expect(implementationProblem(records(), SINGLETON)).toBeNull();
    expect(implementationProblem(records("1.1"), SINGLETON)).toBe(
      "version 1.1 does not meet 1.2, the version this runtime consumes (same major, minor at least)",
    );
  });
});

describe("checkContracts", () => {
  test("binds each implementation that meets its contract, with the contract's private tools", () => {
    const check = checkContracts(
      [
        { plugin: "store", implements: [records("1.3")], requires: [] },
        {
          plugin: "a",
          implements: [tools],
          requires: [{ contract: SINGLETON.id, version: "1.0" }],
        },
        { plugin: "b", implements: [tools], requires: [] },
      ],
      REGISTRY,
    );
    expect(check.problems).toEqual([]);
    expect(check.bindings).toEqual([
      {
        contract: SINGLETON.id,
        version: "1.3",
        plugin: "store",
        server: "store",
        privateTools: ["append"],
      },
      { contract: ADDITIVE.id, version: "1.0", plugin: "a", server: "app", privateTools: [] },
      { contract: ADDITIVE.id, version: "1.0", plugin: "b", server: "app", privateTools: [] },
    ]);
  });

  test("two implementations of a singleton refuse, naming both plugins", () => {
    const check = checkContracts(
      [
        { plugin: "one", implements: [records()], requires: [] },
        { plugin: "two", implements: [records()], requires: [] },
      ],
      REGISTRY,
    );
    expect(check.problems.map((p) => p.plugin)).toEqual(["one", "two"]);
    expect(check.problems[0]!.message).toMatch(/singleton.*\(one, two\)/);
  });

  test("a contract this runtime does not consume is noted, not refused", () => {
    const check = checkContracts(
      [
        {
          plugin: "x",
          implements: [{ contract: "ai.other.thing", version: "3.0", server: "a" }],
          requires: [],
        },
      ],
      REGISTRY,
    );
    expect(check.problems).toEqual([]);
    expect(check.bindings).toEqual([]);
    expect(check.notes).toEqual([
      "x implements ai.other.thing, which this runtime does not consume",
    ]);
  });

  test("an unmet requirement refuses; an unmet optional one is noted", () => {
    const check = checkContracts(
      [
        { plugin: "store", implements: [records("1.2")], requires: [] },
        {
          plugin: "user",
          implements: [],
          requires: [
            { contract: SINGLETON.id, version: "1.3" },
            { contract: ADDITIVE.id, version: "1.0", optional: true },
            { contract: "ai.other.thing", version: "1.0" },
          ],
        },
      ],
      REGISTRY,
    );
    expect(check.problems.map((p) => `${p.plugin} ${p.contract}`)).toEqual([
      "user ai.example.records",
      "user ai.other.thing",
    ]);
    expect(check.notes).toEqual([
      "user requires ai.example.tools 1.0, which no enabled plugin implements at a compatible version; it runs without it",
    ]);
  });

  test("a requirement on a contract this runtime does not consume is met by a plugin implementing it", () => {
    const check = checkContracts(
      [
        {
          plugin: "x",
          implements: [{ contract: "ai.other.thing", version: "1.4", server: "a" }],
          requires: [],
        },
        { plugin: "y", implements: [], requires: [{ contract: "ai.other.thing", version: "1.2" }] },
      ],
      REGISTRY,
    );
    expect(check.problems).toEqual([]);
  });
});
