/**
 * The contracts this kernel consumes (ADR-0076), and the rules that hold
 * plugins to them.
 *
 * A contract's definition is its `contracts/<dir>/contract.json`: a permanent
 * id, a `major.minor` version, a cardinality, and the roles an implementation
 * fills. The registry is read from those files and names no contract in code.
 *
 * - **Version.** An implementation at `M.m` meets a need for `N.n` when
 *   `M = N` and `m >= n`. The kernel needs the version its `contract.json`
 *   states; a plugin's `requires` states its own.
 * - **Roles.** An implementation maps every role the contract defines to one
 *   of its servers, and no role the contract does not define.
 * - **Cardinality.** A `singleton` contract has at most one enabled
 *   implementation; an `additive` one may have many.
 *
 * Everything below the loader is pure: it takes definitions and declarations
 * and returns problems, never throws on a plugin's mistake.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ContractImplementation, ContractRequirement } from "./extension.ts";

/** Where the kernel's contracts live: `contracts/` at the repository root. */
export const CONTRACTS_DIR = resolve(import.meta.dir, "../../contracts");

export type Cardinality = "singleton" | "additive";
export type RoleVisibility = "public" | "private";

/** One contract's `contract.json`. */
export interface ContractDefinition {
  id: string;
  version: string;
  cardinality: Cardinality;
  roles: Record<string, { visibility: RoleVisibility }>;
}

/** The contracts this kernel consumes, by id. */
export type ContractRegistry = ReadonlyMap<string, ContractDefinition>;

const ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/**
 * Read every `<dir>/*\/contract.json`. A directory without one is not a
 * contract and is skipped. Throws on a definition that is malformed or an id
 * two directories share: that is a defect in this repository, not in a plugin.
 */
export function loadContracts(dir: string = CONTRACTS_DIR): ContractRegistry {
  const out = new Map<string, ContractDefinition>();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name, "contract.json");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const def = parseContractDefinition(JSON.parse(readFileSync(file, "utf-8")), file);
    if (out.has(def.id)) throw new Error(`${file}: contract ${def.id} is defined twice`);
    out.set(def.id, def);
  }
  return out;
}

/** Validate one `contract.json`. Throws naming the file and the field. */
export function parseContractDefinition(raw: unknown, file: string): ContractDefinition {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const fail = (what: string): never => {
    throw new Error(`${file}: ${what}`);
  };
  if (typeof obj.id !== "string" || !ID.test(obj.id)) fail("id must be a reverse-DNS name");
  if (typeof obj.version !== "string" || !VERSION.test(obj.version)) {
    fail('version must be "major.minor"');
  }
  if (obj.cardinality !== "singleton" && obj.cardinality !== "additive") {
    fail('cardinality must be "singleton" or "additive"');
  }
  const roles = obj.roles;
  if (typeof roles !== "object" || roles === null || Object.keys(roles).length === 0) {
    fail("roles must name at least one role");
  }
  const out: ContractDefinition["roles"] = {};
  for (const [role, spec] of Object.entries(roles as Record<string, unknown>)) {
    const visibility = (spec as { visibility?: unknown } | null)?.visibility;
    if (visibility !== "public" && visibility !== "private") {
      fail(`roles.${role}.visibility must be "public" or "private"`);
    }
    out[role] = { visibility: visibility as RoleVisibility };
  }
  return {
    id: obj.id as string,
    version: obj.version as string,
    cardinality: obj.cardinality as Cardinality,
    roles: out,
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
  /** Role → the plugin's server key. */
  servers: Record<string, string>;
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

/** Why one implementation does not meet its contract, one entry per reason. */
export function implementationProblems(
  impl: ContractImplementation,
  def: ContractDefinition,
): string[] {
  const out: string[] = [];
  if (!versionMeets(impl.version, def.version)) {
    out.push(
      `version ${impl.version} does not meet ${def.version}, the version this runtime consumes (same major, minor at least)`,
    );
  }
  for (const role of Object.keys(def.roles)) {
    if (!(role in impl.servers)) out.push(`role "${role}" is not mapped to a server`);
  }
  for (const role of Object.keys(impl.servers)) {
    if (!(role in def.roles)) out.push(`role "${role}" is not a role of the contract`);
  }
  return out;
}

/**
 * Hold every enabled plugin's contract declarations to the registry and to
 * each other: each implementation of a consumed contract to its version and
 * roles, each singleton to one implementation, and each requirement to an
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
  const why = implementationProblems(impl, def);
  for (const message of why) check.problems.push({ plugin, contract: impl.contract, message });
  if (why.length > 0) return;
  check.bindings.push({
    contract: impl.contract,
    version: impl.version,
    plugin,
    servers: { ...impl.servers },
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
