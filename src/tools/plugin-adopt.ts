/**
 * Adopting existing installs into plugins (ADR-0077, "Existing installs"): a
 * reconcile that runs on boot, before the connectors start, and writes an
 * installed-plugin record for a connector a catalog install made before
 * records existed. No data migration: a connector that does not qualify stays
 * exactly as it is.
 *
 * **What qualifies.** A connector is adopted into the plugin at `name@catalog`
 * only when all three hold:
 *
 * 1. it carries catalog provenance: its `skillsLock` records a plugin and the
 *    server it was bound to (the zip-scanning resolver wrote both at a catalog
 *    install), it carries no `installedBy`, and no record of its owner names it.
 *    A connector its owner added by URL carries no lock (and a `display`), so it
 *    is never adopted, whatever a listing names;
 * 2. exactly one entry across the configured listings names that server in its
 *    `servers` (or, for a bare connector, is its inline record). A listing that
 *    cannot be read at all leaves every candidate for the next boot, since
 *    "exactly one" cannot be judged without it;
 * 3. that entry's artifact, fetched and verified against its digest, contains
 *    the server.
 *
 * Otherwise the connector stays a plain connector and the reconcile logs the
 * entries that claim it, once per boot.
 *
 * **What adoption writes**, per plugin and owner, under the owner's lifecycle
 * lock (`oneAtATime`, shared with install, uninstall and update):
 *
 * 1. the plugin's managed skills for the adopted connections, and its unbound
 *    ones (`materializeSkills`). A bound skill lands at the path the old
 *    binding used (`connector-skills/<serverName>/<name>.md`), so it is
 *    rewritten in place, never duplicated; then whatever the old binding left
 *    there that the plugin no longer carries goes;
 * 2. the record: the address, the artifact's digest, the adopted connectors
 *    with the artifact's server records, the skills and the starters;
 * 3. each connector rewritten in place: `installedBy` set to the address and
 *    its `skillsLock` dropped. Its connection, settings and credentials stay.
 *
 * The record is written before the connectors are marked, so a boot that
 * stops between the two finds a record naming a connector that still carries
 * its lock, and finishes marking it with no fetch. A second boot finds nothing
 * to adopt and reads no listing and no artifact.
 *
 * **Bounded.** An artifact is fetched only for a plugin some connector is being
 * adopted into, at most {@link MAX_FETCHES_PER_BOOT} per boot and
 * {@link FETCH_CONCURRENCY} at a time; artifacts are cached by digest, so a
 * plugin several owners have is fetched once.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { SERVER_RECORD_TYPE } from "../catalogs/listing.ts";
import type { CatalogSnapshot } from "../catalogs/reader.ts";
import { serverNameFromRef } from "../connectors/runtime/paths.ts";
import type { ConnectorRef } from "../connectors/runtime/types.ts";
import { IdentityConnectorStore } from "../identity/connector-store.ts";
import { log } from "../observability/log.ts";
import {
  ArtifactError,
  obtainArtifact,
  type PluginContents,
  readArtifact,
} from "../plugins/installed/artifact.ts";
import {
  connectionOf,
  type InstalledPluginRecord,
  type PluginOwner,
  type PluginRecordStore,
} from "../plugins/installed/record.ts";
import { managedSkillRoots, removeUnownedConnectorSkills } from "../skills/managed-skills.ts";
import { serializePerWorkspace } from "../workspace/serialize.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { materializeSkills, oneAtATime } from "./plugin-install.ts";

/** The most artifacts one boot fetches for adoption; the rest wait for the next boot. */
export const MAX_FETCHES_PER_BOOT = 20;

/** How many artifacts adoption fetches at once. */
export const FETCH_CONCURRENCY = 3;

type ListedEntry = CatalogSnapshot["entries"][number];

export interface PluginAdoptionDeps {
  workDir: string;
  workspaces: WorkspaceStore;
  records: PluginRecordStore;
  /** The configured catalogs' listings, read only when a connector is a candidate. */
  snapshots: () => Promise<CatalogSnapshot[]>;
  /** Injectable fetch for artifacts; tests pass a fixture. */
  fetchImpl?: typeof fetch;
}

export interface PluginAdoptionResult {
  /** Connectors adopted (or finished) into a record this boot. */
  adopted: Array<{ owner: PluginOwner; serverName: string; address: string }>;
  /** Connectors left as plain connectors, with the entries that claim them. */
  unchanged: Array<{ owner: PluginOwner; serverName: string; claimants: string[]; why: string }>;
  /** Artifacts fetched or read from the cache this boot. */
  artifactsRead: number;
}

/** A connector that carries catalog provenance and no record yet. */
interface Candidate {
  ref: ConnectorRef;
  serverName: string;
  /** The registry name its lock records (`com.notion/mcp`). */
  registry: string;
}

/** The registry name a pre-record catalog install's lock records, or null when it has none. */
export function catalogProvenance(ref: ConnectorRef): string | null {
  if (ref.installedBy || ref.display) return null;
  const lock = ref.skillsLock?.find((e) => e.plugin && e.server);
  return lock?.server ?? null;
}

function ownerLabel(owner: PluginOwner): string {
  return owner.kind === "workspace" ? `workspace ${owner.wsId}` : `person ${owner.userId}`;
}

/** The ref with its plugin provenance: `installedBy` set, the old binding's lock gone. */
function marked(ref: ConnectorRef, address: string): ConnectorRef {
  const { skillsLock: _lock, ...rest } = ref;
  return { ...rest, installedBy: ref.installedBy ?? address };
}

/** Run the boot reconcile over every workspace and every person. Never throws. */
export async function adoptExistingInstalls(
  deps: PluginAdoptionDeps,
): Promise<PluginAdoptionResult> {
  const result: PluginAdoptionResult = { adopted: [], unchanged: [], artifactsRead: 0 };
  const shared = new SharedReads(deps);
  const identity = new IdentityConnectorStore({ workDir: deps.workDir });
  const owners: Array<{ owner: PluginOwner; refs: () => Promise<ConnectorRef[]> }> = [];
  try {
    for (const ws of await deps.workspaces.list()) {
      owners.push({
        owner: { kind: "workspace", wsId: ws.id },
        refs: async () => (await deps.workspaces.get(ws.id))?.connectors ?? [],
      });
    }
  } catch (err) {
    log.warn(`[plugins] adoption: workspaces cannot be listed: ${String(err)}`);
  }
  for (const userId of personIds(deps.workDir)) {
    owners.push({ owner: { kind: "person", userId }, refs: () => identity.list(userId) });
  }
  for (const { owner, refs } of owners) {
    try {
      await oneAtATime(owner, () => adoptForOwner(deps, owner, refs, identity, shared, result));
    } catch (err) {
      log.warn(`[plugins] adoption for ${ownerLabel(owner)} failed (non-fatal): ${String(err)}`);
    }
  }
  result.artifactsRead = shared.artifactsRead;
  return result;
}

/** Every directory under `users/`: the people who may hold a connector record. */
function personIds(workDir: string): string[] {
  try {
    return readdirSync(join(workDir, "users"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Reads shared across owners in one boot: the listings once, each artifact once. */
class SharedReads {
  artifactsRead = 0;
  #entries: Promise<ListedEntry[] | null> | null = null;
  #artifacts = new Map<string, Promise<{ contents: PluginContents; digest: string } | string>>();
  readonly #deps: PluginAdoptionDeps;
  #slots = FETCH_CONCURRENCY;
  #waiting: Array<() => void> = [];

  constructor(deps: PluginAdoptionDeps) {
    this.#deps = deps;
  }

  /** Every listed entry, or null when some catalog has nothing readable. */
  entries(): Promise<ListedEntry[] | null> {
    this.#entries ??= this.#deps.snapshots().then((snapshots) => {
      const unread = snapshots.filter((s) => s.origin === "none");
      if (unread.length > 0) {
        log.warn(
          `[plugins] adoption waits for the next boot: ${unread.map((s) => s.catalog.name).join(", ")} could not be read`,
        );
        return null;
      }
      return snapshots.flatMap((s) => s.entries);
    });
    return this.#entries;
  }

  /** The verified contents of `entry`'s artifact, or why it cannot be read. */
  artifact(entry: ListedEntry): Promise<{ contents: PluginContents; digest: string } | string> {
    const key = `${entry.address} ${entry.digest ?? ""}`;
    let read = this.#artifacts.get(key);
    if (!read) {
      if (this.#artifacts.size >= MAX_FETCHES_PER_BOOT) {
        return Promise.resolve(`more than ${MAX_FETCHES_PER_BOOT} plugins to adopt; next boot`);
      }
      read = this.#limited(async () => {
        this.artifactsRead++;
        try {
          const { bytes, digest } = await obtainArtifact(entry, {
            cacheDir: join(this.#deps.workDir, "cache", "plugins"),
            ...(this.#deps.fetchImpl ? { fetchImpl: this.#deps.fetchImpl } : {}),
          });
          return { contents: readArtifact(entry, bytes), digest };
        } catch (err) {
          if (err instanceof ArtifactError) return err.message;
          return String(err);
        }
      });
      this.#artifacts.set(key, read);
    }
    return read;
  }

  async #limited<T>(task: () => Promise<T>): Promise<T> {
    if (this.#slots === 0) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    else this.#slots--;
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#slots++;
    }
  }
}

/** Whether `entry` names the server with registry name `registry`. */
function claims(entry: ListedEntry, registry: string): boolean {
  if (Object.values(entry.servers).some((s) => s.name === registry)) return true;
  const data = entry.data as { name?: unknown } | undefined;
  return entry.type === SERVER_RECORD_TYPE && data?.name === registry;
}

async function adoptForOwner(
  deps: PluginAdoptionDeps,
  owner: PluginOwner,
  readRefs: () => Promise<ConnectorRef[]>,
  identity: IdentityConnectorStore,
  shared: SharedReads,
  result: PluginAdoptionResult,
): Promise<void> {
  const refs = await readRefs();
  if (refs.length === 0) return;
  const records = await deps.records.list(owner);
  const { finish, candidates } = triage(refs, records);
  for (const [serverName, address] of finish) {
    await markConnector(deps, identity, owner, serverName, address);
    result.adopted.push({ owner, serverName, address });
  }
  if (candidates.length === 0) return;
  const entries = await shared.entries();
  if (!entries) return;
  const groups = byClaimant(candidates, entries, (c, claimants, why) =>
    leave(result, owner, c, claimants, why),
  );
  const reads = [...groups.values()].map(async (g) => ({
    ...g,
    read: await shared.artifact(g.entry),
  }));
  for (const { entry, candidates: group, read } of await Promise.all(reads)) {
    const adopted = adoptable(group, read, (c, why) =>
      leave(result, owner, c, [entry.address], why),
    );
    if (typeof read === "string" || adopted.length === 0) continue;
    await adoptInto(deps, identity, owner, entry, read, adopted);
    for (const c of adopted) {
      result.adopted.push({ owner, serverName: c.serverName, address: entry.address });
    }
  }
}

/** The candidates the verified artifact contains; each other one is left with why. */
function adoptable(
  group: readonly Candidate[],
  read: { contents: PluginContents } | string,
  left: (c: Candidate, why: string) => void,
): Candidate[] {
  if (typeof read === "string") {
    for (const c of group) left(c, `its artifact cannot be read: ${read}`);
    return [];
  }
  const adopted = group.filter((c) => contains(read, c));
  for (const c of group) {
    if (!adopted.includes(c)) left(c, "the verified artifact does not contain its server");
  }
  return adopted;
}

function contains(read: { contents: PluginContents }, c: Candidate): boolean {
  return read.contents.servers.some((s) => s.name === c.registry);
}

/**
 * The owner's connectors a record already names but that still carry the old
 * binding (an adoption that stopped before marking them), by the record's
 * address, and the connectors with catalog provenance no record names.
 */
function triage(
  refs: readonly ConnectorRef[],
  records: readonly InstalledPluginRecord[],
): { finish: Map<string, string>; candidates: Candidate[] } {
  const finish = new Map<string, string>();
  const candidates: Candidate[] = [];
  for (const ref of refs) {
    const serverName = serverNameFromRef(ref);
    if (!serverName) continue;
    const named = records.find((r) => r.connectors.some((c) => connectionOf(c) === serverName));
    if (!named) {
      const registry = catalogProvenance(ref);
      if (registry) candidates.push({ ref, serverName, registry });
      continue;
    }
    const unfinished = !ref.installedBy || ref.installedBy === named.address;
    if (ref.skillsLock && !ref.display && unfinished) finish.set(serverName, named.address);
  }
  return { finish, candidates };
}

/** The candidates exactly one listing entry claims, grouped by that entry; the rest are left. */
function byClaimant(
  candidates: readonly Candidate[],
  entries: readonly ListedEntry[],
  left: (c: Candidate, claimants: string[], why: string) => void,
): Map<string, { entry: ListedEntry; candidates: Candidate[] }> {
  const groups = new Map<string, { entry: ListedEntry; candidates: Candidate[] }>();
  for (const c of candidates) {
    const claimants = entries.filter((e) => claims(e, c.registry));
    const entry = claimants[0];
    if (claimants.length !== 1 || !entry) {
      left(
        c,
        claimants.map((e) => e.address),
        claimants.length === 0
          ? "no listing entry names its server"
          : "more than one listing entry names its server",
      );
      continue;
    }
    const group = groups.get(entry.address) ?? { entry, candidates: [] };
    group.candidates.push(c);
    groups.set(entry.address, group);
  }
  return groups;
}

function leave(
  result: PluginAdoptionResult,
  owner: PluginOwner,
  c: Candidate,
  claimants: string[],
  why: string,
): void {
  result.unchanged.push({ owner, serverName: c.serverName, claimants, why });
  log.info(
    `[plugins] ${ownerLabel(owner)}: ${c.serverName} (${c.registry}) stays a plain connector: ${why}${claimants.length > 0 ? ` (claimed by ${claimants.join(", ")})` : ""}`,
  );
}

/** Write `entry`'s plugin for `adopted`: skills, then the record, then each connector's mark. */
async function adoptInto(
  deps: PluginAdoptionDeps,
  identity: IdentityConnectorStore,
  owner: PluginOwner,
  entry: ListedEntry,
  read: { contents: PluginContents; digest: string },
  adopted: Candidate[],
): Promise<void> {
  const servers = read.contents.servers.filter((s) => adopted.some((c) => c.registry === s.name));
  const keys = new Set(servers.map((s) => s.key));
  // What this owner gets: the adopted servers, and the skills that bind to one
  // of them or to none. A skill bound to a server it does not have is not produced.
  const contents: PluginContents = {
    ...read.contents,
    servers,
    skills: read.contents.skills.filter((s) => !s.server || keys.has(s.server)),
  };
  const skills = materializeSkills(deps.workDir, owner, entry.address, contents);
  const roots = managedSkillRoots(deps.workDir, owner);
  // Each adopted connection's skill directory keeps exactly the skills this
  // plugin now binds to it. No other record names an adopted connection
  // (`triage` adopts only connectors no record names), so none of its skills
  // is there; an old binding's file goes even under this plugin's address.
  for (const c of adopted) {
    const keep = new Set(
      skills
        .filter((s) => servers.some((v) => v.key === s.server && connectionOf(v) === c.serverName))
        .map((s) => s.name),
    );
    removeUnownedConnectorSkills({ roots, serverName: c.serverName, keep });
  }
  await deps.records.put(owner, {
    address: entry.address,
    digest: read.digest,
    type: entry.type,
    installedAt: new Date().toISOString(),
    connectors: servers.map((s) => ({ key: s.key, name: s.name, server: s.detail })),
    skills,
    starters: read.contents.starters,
  });
  for (const c of adopted) await markConnector(deps, identity, owner, c.serverName, entry.address);
  log.info(
    `[plugins] ${ownerLabel(owner)}: adopted ${adopted.map((c) => c.serverName).join(", ")} into ${entry.address} at ${read.digest}`,
  );
}

/** Rewrite one connector in place with its plugin provenance. */
async function markConnector(
  deps: PluginAdoptionDeps,
  identity: IdentityConnectorStore,
  owner: PluginOwner,
  serverName: string,
  address: string,
): Promise<void> {
  if (owner.kind === "person") {
    await identity.replace(owner.userId, serverName, (ref) => marked(ref, address));
    return;
  }
  await serializePerWorkspace(owner.wsId, async () => {
    const ws = await deps.workspaces.get(owner.wsId);
    if (!ws) return;
    const connectors = ws.connectors.map((ref) =>
      serverNameFromRef(ref) === serverName ? marked(ref, address) : ref,
    );
    await deps.workspaces.update(owner.wsId, { connectors });
  });
}
