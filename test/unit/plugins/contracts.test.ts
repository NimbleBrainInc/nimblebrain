import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContractDefinition,
  type ContractRegistry,
  checkContracts,
  implementationProblems,
  loadContracts,
  parseContractDefinition,
  versionMeets,
} from "../../../src/plugins/contracts.ts";

const SINGLETON: ContractDefinition = {
  id: "ai.example.records",
  version: "1.2",
  cardinality: "singleton",
  roles: { app: { visibility: "public" }, records: { visibility: "private" } },
};
const ADDITIVE: ContractDefinition = {
  id: "ai.example.tools",
  version: "1.0",
  cardinality: "additive",
  roles: { app: { visibility: "public" } },
};
const REGISTRY: ContractRegistry = new Map([
  [SINGLETON.id, SINGLETON],
  [ADDITIVE.id, ADDITIVE],
]);

const records = (version = "1.2") => ({
  contract: SINGLETON.id,
  version,
  servers: { app: "app", records: "records" },
});
const tools = { contract: ADDITIVE.id, version: "1.0", servers: { app: "app" } };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadContracts", () => {
  test("reads the repository's contracts: conversations today", () => {
    const registry = loadContracts();
    expect(registry.get("ai.nimblebrain.conversations")).toEqual({
      id: "ai.nimblebrain.conversations",
      version: "1.0",
      cardinality: "singleton",
      roles: { app: { visibility: "public" }, records: { visibility: "private" } },
    });
  });

  test("skips a directory with no contract.json, and refuses an id defined twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "contracts-"));
    dirs.push(dir);
    mkdirSync(join(dir, "notes"));
    for (const name of ["a", "b"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "contract.json"), JSON.stringify(SINGLETON));
    }
    expect(() => loadContracts(dir)).toThrow(/defined twice/);
  });

  test("a missing directory is an empty registry", () => {
    expect(loadContracts(join(tmpdir(), "no-such-contracts-dir")).size).toBe(0);
  });
});

describe("parseContractDefinition", () => {
  test("names the file and the field it refuses", () => {
    const ok = { ...SINGLETON };
    expect(parseContractDefinition(ok, "c.json")).toEqual(SINGLETON);
    expect(() => parseContractDefinition({ ...ok, version: "1" }, "c.json")).toThrow(
      'c.json: version must be "major.minor"',
    );
    expect(() => parseContractDefinition({ ...ok, cardinality: "many" }, "c.json")).toThrow(
      /cardinality/,
    );
    expect(() => parseContractDefinition({ ...ok, roles: {} }, "c.json")).toThrow(/roles/);
    expect(() =>
      parseContractDefinition({ ...ok, roles: { app: { visibility: "secret" } } }, "c.json"),
    ).toThrow("c.json: roles.app.visibility");
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

describe("implementationProblems", () => {
  test("holds an implementation to the contract's version and every role", () => {
    expect(implementationProblems(records(), SINGLETON)).toEqual([]);
    expect(
      implementationProblems(
        { contract: SINGLETON.id, version: "1.1", servers: { app: "app", typo: "x" } },
        SINGLETON,
      ),
    ).toEqual([
      "version 1.1 does not meet 1.2, the version this runtime consumes (same major, minor at least)",
      'role "records" is not mapped to a server',
      'role "typo" is not a role of the contract',
    ]);
  });
});

describe("checkContracts", () => {
  test("binds each implementation that meets its contract", () => {
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
    expect(check.bindings.map((b) => `${b.plugin}:${b.contract}@${b.version}`)).toEqual([
      "store:ai.example.records@1.3",
      "a:ai.example.tools@1.0",
      "b:ai.example.tools@1.0",
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
          implements: [{ contract: "ai.other.thing", version: "3.0", servers: { a: "b" } }],
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
          implements: [{ contract: "ai.other.thing", version: "1.4", servers: { a: "b" } }],
          requires: [],
        },
        { plugin: "y", implements: [], requires: [{ contract: "ai.other.thing", version: "1.2" }] },
      ],
      REGISTRY,
    );
    expect(check.problems).toEqual([]);
  });
});
