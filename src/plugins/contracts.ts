/**
 * The contracts this kernel consumes (ADR-0076), and the rules that hold
 * plugins to them.
 *
 * A contract is one published document per major version,
 * `schemas/contracts/<name>/v<major>/contract.json`: its permanent name
 * (`contract`), a `major.minor` version, a cardinality, and its tools, each
 * public or private. The registry is read from those documents and names no
 * contract in code.
 *
 * - **Version.** An implementation at `M.m` meets a need for `N.n` when
 *   `M = N` and `m >= n`. The kernel needs the version the document states; a
 *   plugin's `requires` states its own.
 * - **Server.** An implementation names the one server that serves the
 *   contract's tools; that it is a server of the plugin is the manifest
 *   reader's check.
 * - **Cardinality.** A `singleton` contract has at most one enabled
 *   implementation; an `additive` one may have many.
 *
 * Everything below the loader is pure: it takes definitions and declarations
 * and returns problems, never throws on a plugin's mistake.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ContractImplementation, ContractRequirement } from "./extension.ts";

/** Where the kernel's contract documents live: `schemas/contracts/` at the repository root. */
export const CONTRACTS_DIR = resolve(import.meta.dir, "../../schemas/contracts");

export type Cardinality = "singleton" | "additive";

/** What the kernel reads of one contract document. */
export interface ContractDefinition {
  /** The contract's permanent name, e.g. `ai.nimblebrain.conversations`. */
  id: string;
  version: string;
  cardinality: Cardinality;
  /** The tools the host never offers to agents, by name. */
  privateTools: string[];
  /** The tools marked `unattended: "refused"`: no call a run makes reaches them. */
  unattendedRefused: string[];
  /** The tools marked `grant: true`: a person's call to one carries a run grant. */
  grantTools: string[];
  /** The public tools annotated `readOnlyHint: false`: a call to one changes what its caller's views show. */
  writeTools: string[];
}

/** The contracts this kernel consumes, by name. */
export type ContractRegistry = ReadonlyMap<string, ContractDefinition>;

const ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/**
 * Read every `<dir>/<name>/v<major>/contract.json`. Throws on a document that
 * is malformed, sits under a major its version does not state, or names a
 * contract another document also names: those are defects in this
 * repository, not in a plugin.
 */
export function loadContracts(dir: string = CONTRACTS_DIR): ContractRegistry {
  const out = new Map<string, ContractDefinition>();
  for (const { file, major } of contractFiles(dir)) {
    const def = parseContractDefinition(JSON.parse(readFileSync(file, "utf-8")), file);
    if (`v${parseVersion(def.version)?.major}` !== major) {
      throw new Error(`${file}: version ${def.version} is not major ${major}`);
    }
    if (out.has(def.id)) throw new Error(`${file}: contract ${def.id} is defined twice`);
    out.set(def.id, def);
  }
  return out;
}

/** Every `<dir>/<name>/v<major>/contract.json`, with the `v<major>` it sits under. */
function contractFiles(dir: string): Array<{ file: string; major: string }> {
  if (!existsSync(dir)) return [];
  const subdirs = (path: string) =>
    readdirSync(path, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [e.name] : []));
  return subdirs(dir).flatMap((name) =>
    subdirs(join(dir, name))
      .filter((major) => /^v\d+$/.test(major))
      .map((major) => ({ file: join(dir, name, major, "contract.json"), major }))
      .filter(({ file }) => existsSync(file)),
  );
}

/** Validate what the kernel reads of one contract document. Throws naming the file and the field. */
export function parseContractDefinition(raw: unknown, file: string): ContractDefinition {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const fail = (what: string): never => {
    throw new Error(`${file}: ${what}`);
  };
  if (typeof obj.contract !== "string" || !ID.test(obj.contract)) {
    fail("contract must be a reverse-DNS name");
  }
  if (typeof obj.version !== "string" || !VERSION.test(obj.version)) {
    fail('version must be "major.minor"');
  }
  if (obj.cardinality !== "singleton" && obj.cardinality !== "additive") {
    fail('cardinality must be "singleton" or "additive"');
  }
  const tools = obj.tools;
  if (typeof tools !== "object" || tools === null || Object.keys(tools).length === 0) {
    fail("tools must name at least one tool");
  }
  return {
    id: obj.contract as string,
    version: obj.version as string,
    cardinality: obj.cardinality as Cardinality,
    ...toolSets(tools as Record<string, unknown>, fail),
  };
}

/**
 * The document's tools by marking: private, refused unattended (every private
 * tool too), grant-marked, and the public tools whose annotations say they write.
 */
function toolSets(
  tools: Record<string, unknown>,
  fail: (what: string) => never,
): Pick<ContractDefinition, "privateTools" | "unattendedRefused" | "grantTools" | "writeTools"> {
  const sets = {
    privateTools: [] as string[],
    unattendedRefused: [] as string[],
    grantTools: [] as string[],
    writeTools: [] as string[],
  };
  for (const [tool, spec] of Object.entries(tools)) {
    const marks = toolMarks(tool, spec, fail);
    if (marks.visibility === "private") sets.privateTools.push(tool);
    if (marks.visibility === "private" || marks.unattended === "refused") {
      sets.unattendedRefused.push(tool);
    }
    if (marks.grant) sets.grantTools.push(tool);
    if (marks.visibility === "public" && marks.writes) sets.writeTools.push(tool);
  }
  return sets;
}

/** One tool's markings, checked: visibility, unattended, and grant (only on a public tool refused unattended). */
function toolMarks(
  tool: string,
  spec: unknown,
  fail: (what: string) => never,
): {
  visibility: "public" | "private";
  unattended?: "allowed" | "refused";
  grant: boolean;
  writes: boolean;
} {
  const marks = (spec ?? {}) as {
    visibility?: unknown;
    unattended?: unknown;
    grant?: unknown;
    annotations?: { readOnlyHint?: unknown } | null;
  };
  const { visibility, unattended, grant } = marks;
  if (visibility !== "public" && visibility !== "private") {
    fail(`tools.${tool}.visibility must be "public" or "private"`);
  }
  if (unattended !== undefined && unattended !== "allowed" && unattended !== "refused") {
    fail(`tools.${tool}.unattended must be "allowed" or "refused"`);
  }
  if (grant !== undefined && typeof grant !== "boolean")
    fail(`tools.${tool}.grant must be a boolean`);
  if (grant === true && (visibility !== "public" || unattended !== "refused")) {
    fail(`tools.${tool}.grant is allowed only on a public tool refused unattended`);
  }
  return {
    visibility: visibility as "public" | "private",
    ...(unattended !== undefined ? { unattended: unattended as "allowed" | "refused" } : {}),
    grant: grant === true,
    writes: marks.annotations?.readOnlyHint === false,
  };
}

/** `major.minor` as numbers, or null when it is not that shape. */
export function parseVersion(version: string): { major: number; minor: number } | null {
  const m = VERSION.exec(version);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** Whether an implementation at `have` meets a need for `need`: the same major, and a minor at least as high. */
export function versionMeets(have: string, need: string): boolean {
  const h = parseVersion(have);
  const n = parseVersion(need);
  return h !== null && n !== null && h.major === n.major && h.minor >= n.minor;
}

/** What one enabled plugin declares about contracts. */
export interface PluginContracts {
  plugin: string;
  implements: readonly ContractImplementation[];
  requires: readonly ContractRequirement[];
}

/** An implementation of a contract this kernel consumes, held to the contract. */
export interface ContractBinding {
  contract: string;
  version: string;
  plugin: string;
  /** The plugin's mcp.json key of the server that implements it. */
  server: string;
  /** The version of the contract this kernel consumes: what it sends as `version` on a private call. */
  hostVersion: string;
  /** The contract's private tools on that server, which the host never offers to agents. */
  privateTools: string[];
  /** The contract's tools no call made inside an unattended run reaches. */
  unattendedRefused: string[];
  /** The contract's tools whose person calls carry a run grant. */
  grantTools: string[];
  /** The contract's public tools that write, by their annotations. */
  writeTools: string[];
}

/** Why a set of plugins cannot run together: the plugin, the contract, and what is wrong. */
export interface ContractProblem {
  plugin: string;
  contract: string;
  message: string;
}

export interface ContractCheck {
  bindings: ContractBinding[];
  problems: ContractProblem[];
  /** Facts worth logging that refuse nothing: a contract this kernel does not consume, an unmet optional requirement. */
  notes: string[];
}

/** Why one implementation does not meet its contract, or null when it does. */
export function implementationProblem(
  impl: ContractImplementation,
  def: ContractDefinition,
): string | null {
  return versionMeets(impl.version, def.version)
    ? null
    : `version ${impl.version} does not meet ${def.version}, the version this runtime consumes (same major, minor at least)`;
}

/**
 * Hold every enabled plugin's contract declarations to the registry and to
 * each other: each implementation of a consumed contract to its version, each singleton to one implementation, and each requirement to an
 * implementation that meets it.
 */
export function checkContracts(
  plugins: readonly PluginContracts[],
  registry: ContractRegistry,
): ContractCheck {
  const check: ContractCheck = { bindings: [], problems: [], notes: [] };
  for (const p of plugins) {
    for (const impl of p.implements) bindImplementation(p.plugin, impl, registry, check);
  }
  check.problems.push(...cardinalityProblems(check.bindings, registry));
  for (const p of plugins) {
    for (const need of p.requires) checkRequirement(p.plugin, need, plugins, check);
  }
  return check;
}

/** Hold one implementation to its contract; bind it when it meets it. */
function bindImplementation(
  plugin: string,
  impl: ContractImplementation,
  registry: ContractRegistry,
  check: ContractCheck,
): void {
  const def = registry.get(impl.contract);
  if (!def) {
    check.notes.push(`${plugin} implements ${impl.contract}, which this runtime does not consume`);
    return;
  }
  const why = implementationProblem(impl, def);
  if (why) {
    check.problems.push({ plugin, contract: impl.contract, message: why });
    return;
  }
  check.bindings.push({
    contract: impl.contract,
    version: impl.version,
    plugin,
    server: impl.server,
    hostVersion: def.version,
    privateTools: [...def.privateTools],
    unattendedRefused: [...def.unattendedRefused],
    grantTools: [...def.grantTools],
    writeTools: [...def.writeTools],
  });
}

/** One problem per implementer of a singleton contract that more than one plugin implements. */
function cardinalityProblems(
  bindings: readonly ContractBinding[],
  registry: ContractRegistry,
): ContractProblem[] {
  const byContract = new Map<string, string[]>();
  for (const b of bindings) {
    byContract.set(b.contract, [...(byContract.get(b.contract) ?? []), b.plugin]);
  }
  return [...byContract].flatMap(([contract, implementers]) =>
    implementers.length > 1 && registry.get(contract)?.cardinality === "singleton"
      ? implementers.map((plugin) => ({
          plugin,
          contract,
          message: `${contract} is a singleton, and ${implementers.length} enabled plugins implement it (${implementers.join(", ")}); enable one`,
        }))
      : [],
  );
}

/** A requirement is met by any enabled plugin's implementation at a compatible version. */
function checkRequirement(
  plugin: string,
  need: ContractRequirement,
  plugins: readonly PluginContracts[],
  check: ContractCheck,
): void {
  const met = plugins.some((other) =>
    other.implements.some(
      (impl) => impl.contract === need.contract && versionMeets(impl.version, need.version),
    ),
  );
  if (met) return;
  const what = `requires ${need.contract} ${need.version}, which no enabled plugin implements at a compatible version`;
  if (need.optional) check.notes.push(`${plugin} ${what}; it runs without it`);
  else check.problems.push({ plugin, contract: need.contract, message: what });
}
