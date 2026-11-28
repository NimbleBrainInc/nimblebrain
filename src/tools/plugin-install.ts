/**
 * Installing, uninstalling and updating a catalog item (ADR-0077): the one
 * install path for a plugin, a bare connector and a bare skill, and the
 * installed-plugin record that says what each produced.
 *
 * **Install** of `name@catalog`, in the ADR's order:
 *
 * 1. the entry, from the cached listing (`CatalogListings`);
 * 2. its artifact, fetched or taken inline and verified against `digest`
 *    (`obtainArtifact`, cached by digest);
 * 3. its manifest, validated, a `stdio` server refused (`readArtifact`);
 * 4. each server's record from the artifact, connected through the connector
 *    install path that exists for every catalog install (`ConnectorOps.connect`:
 *    the OAuth, DCR, static-client and broker flows unchanged), the connection
 *    marked with the plugin's address (`ConnectorRef.installedBy`). A server
 *    this owner already has connected by a plugin is reused, never connected
 *    twice;
 * 5. its skills, materialized as managed skills;
 * 6. its conversation starters, kept on the record;
 * 7. the record, written last.
 *
 * **Crash-safe by idempotence.** Every step before the record converges when
 * run again: a connection the plugin created is reused, a skill's file is
 * rewritten in place. So an install that stops between steps leaves no record,
 * and installing again finishes it and writes the record; nothing is
 * half-owned.
 *
 * **One lifecycle operation per owner at a time.** Install, uninstall and
 * update each read the owner's records to decide what to connect, keep or
 * remove, so two overlapping ones would decide on a stale read; they run in
 * turn per owner (`oneAtATime`). Each record and connector write also holds
 * the owner's record chain (`src/workspace/serialize.ts`), shared with every
 * other writer of that file.
 *
 * **Uninstall** removes exactly what the record lists: each connection no
 * other plugin of the owner names, and the managed skills. A connection
 * another plugin names stays, and its server record is then that plugin's
 * (the first remaining in the owner's install order). The record
 * goes last, so an uninstall that stops can be run again.
 *
 * **Update** is an admin's act when the listing's digest differs from the
 * record's: the new artifact is fetched and verified, what the plugin owns is
 * replaced, and the record is rewritten. Nothing updates on its own. A
 * connection whose server record this plugin supplies follows the new record:
 * when its endpoint, auth client or scopes change, the connection is rewritten
 * and signs in again, since its credentials belong to the old settings. A
 * connection another plugin supplies is left as that plugin's record says.
 *
 * A connector its owner added is never a plugin's: it carries no
 * `installedBy`, gets no record, and a plugin whose server would land on it is
 * refused rather than adopting it, even at the same URL. Uninstall never
 * removes one.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ListedEntry } from "../catalogs/listing.ts";
import { projectServerDetailToCatalogListing } from "../connectors/catalog/projection.ts";
import type { CatalogListing } from "../connectors/catalog/types.ts";
import type { ConnectorRef } from "../connectors/runtime/types.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
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
  type InstalledPluginSkill,
  type PluginOwner,
} from "../plugins/installed/record.ts";
import type { Runtime } from "../runtime/runtime.ts";
import {
  managedSkillRoots,
  materializeManagedSkill,
  removeManagedSkill,
} from "../skills/managed-skills.ts";
import { keyedChain } from "../workspace/serialize.ts";

/** What plugin install needs from the connector install path, for one owner. */
export interface ConnectorOps {
  /** Null when the caller may install for and remove from `owner`, else the refusal. */
  admit(owner: PluginOwner): Promise<ToolResult | null>;
  /** The owner's connection named `serverName`, when it has one. */
  existing(owner: PluginOwner, serverName: string): Promise<ConnectorRef | null>;
  /**
   * Connect one server from its record's projection, marking a new connection
   * `installedBy`; `alreadyInstalled` when it was connected. With
   * `reconfigure`, an existing connection is moved to the projection's
   * connection settings (`reconnected` when it was); `previous` is the
   * server's listing as the plugin's current record projects it.
   */
  connect(
    owner: PluginOwner,
    listing: CatalogListing,
    opts: { installedBy: string; reconfigure: boolean; previous?: CatalogListing },
  ): Promise<ToolResult>;
  /** Remove one connection, as the connector's own uninstall does. */
  disconnect(owner: PluginOwner, serverName: string): Promise<ToolResult>;
}

export interface PluginInstallContext {
  runtime: Runtime;
  ops: ConnectorOps;
  /** Injectable fetch for the artifact; tests pass a fixture. */
  fetchImpl?: typeof fetch;
}

function err(code: string, message: string): ToolResult {
  return {
    content: textContent(message),
    structuredContent: { error: code, message },
    isError: true,
  };
}

function ownerFields(owner: PluginOwner): Record<string, unknown> {
  return owner.kind === "workspace"
    ? { scope: "workspace", wsId: owner.wsId }
    : { scope: "identity" };
}

/** The listing entry at `address`, from the catalogs' cached listings. */
export async function findListedEntry(
  runtime: Runtime,
  address: string,
): Promise<ListedEntry | null> {
  for (const snapshot of await runtime.getCatalogListings().snapshots()) {
    const entry = snapshot.entries.find((e) => e.address === address);
    if (entry) return entry;
  }
  return null;
}

/** The verified contents of `entry`'s artifact, or the refusal. */
async function fetchContents(
  ctx: PluginInstallContext,
  entry: ListedEntry,
): Promise<{ contents: PluginContents; digest: string } | ToolResult> {
  try {
    const { bytes, digest } = await obtainArtifact(entry, {
      cacheDir: join(ctx.runtime.getWorkDir(), "cache", "plugins"),
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    });
    return { contents: readArtifact(entry, bytes), digest };
  } catch (e) {
    if (e instanceof ArtifactError) return err(e.code, e.message);
    throw e;
  }
}

/**
 * Why this plugin may not use the owner's connection for `listing`'s server,
 * or null when it may: there is none, it is one a plugin created and an
 * installed plugin names (a shared server), or this plugin created it (an
 * install that stopped before its record). A connection no plugin created is
 * the owner's own, whatever its URL, and adopting it would let an uninstall
 * remove what they made.
 */
async function conflict(
  ctx: PluginInstallContext,
  owner: PluginOwner,
  address: string,
  records: InstalledPluginRecord[],
  listing: CatalogListing,
): Promise<string | null> {
  const serverName = connectionOf({ name: listing.id });
  const existing = await ctx.ops.existing(owner, serverName);
  if (!existing) return null;
  if (!existing.installedBy) {
    return `a connector named "${serverName}" was added here by hand (at ${existing.url}), and a plugin never takes over a connector it did not create; remove it first to install this plugin's server`;
  }
  if (existing.installedBy === address) return null;
  if (records.some((r) => r.connectors.some((c) => connectionOf(c) === serverName))) return null;
  return `a connector named "${serverName}" was left by an unfinished install of ${existing.installedBy}; install that plugin again, or remove the connector first`;
}

/** Connect every server of `contents`; the first refusal stops the install. */
async function connectAll(
  ctx: PluginInstallContext,
  owner: PluginOwner,
  address: string,
  contents: PluginContents,
  records: InstalledPluginRecord[],
  reconfigure: (name: string) => { reconfigure: boolean; previous?: CatalogListing } = () => ({
    reconfigure: false,
  }),
): Promise<{ connected: Connected[] } | ToolResult> {
  const listings: Array<{ listing: CatalogListing; name: string }> = [];
  for (const server of contents.servers) {
    const listing = projectServerDetailToCatalogListing(server.detail);
    if (!listing)
      return err("INVALID", `${address}: its server "${server.key}" is not installable`);
    const why = await conflict(ctx, owner, address, records, listing);
    if (why) return err("SERVER_CONFLICT", `${address} cannot be installed: ${why}.`);
    listings.push({ listing, name: server.name });
  }
  const pending = contents.servers.map((s) => ({ address, detail: s.detail }));
  return ctx.runtime.withPendingServerRecords(owner, pending, async () => {
    const connected: Connected[] = [];
    for (const { listing, name } of listings) {
      const result = await ctx.ops.connect(owner, listing, {
        installedBy: address,
        ...reconfigure(name),
      });
      if (result.isError) return result;
      const sc = (result.structuredContent ?? {}) as Record<string, unknown>;
      connected.push({
        serverName: String(sc.serverName ?? connectionOf({ name: listing.id })),
        alreadyInstalled: sc.alreadyInstalled === true,
        reconnected: sc.reconnected === true,
        ...(typeof sc.warning === "string" ? { warning: sc.warning } : {}),
      });
    }
    return { connected };
  });
}

interface Connected {
  serverName: string;
  alreadyInstalled: boolean;
  /** An update moved it to new connection settings; it signs in again. */
  reconnected: boolean;
  warning?: string;
}

const lifecycles = keyedChain();

/** Run one install, uninstall or update of `owner`'s plugins at a time. */
function oneAtATime<T>(owner: PluginOwner, task: () => Promise<T>): Promise<T> {
  const key = owner.kind === "workspace" ? `workspace:${owner.wsId}` : `person:${owner.userId}`;
  return lifecycles.run(key, task);
}

/** Materialize `contents`' skills as managed skills of `owner`. */
function materializeSkills(
  runtime: Runtime,
  owner: PluginOwner,
  address: string,
  contents: PluginContents,
): InstalledPluginSkill[] {
  const roots = managedSkillRoots(runtime.getWorkDir(), owner);
  const now = new Date().toISOString();
  const out: InstalledPluginSkill[] = [];
  for (const skill of contents.skills) {
    const server = skill.server ? contents.servers.find((s) => s.key === skill.server) : undefined;
    const written = materializeManagedSkill({
      roots,
      address,
      skill: skill.name,
      body: skill.body,
      ...(server ? { serverName: connectionOf(server) } : {}),
      now,
    });
    if (!written) {
      log.warn(`[plugins] ${address}: skill "${skill.name}" does not parse and was not installed`);
      continue;
    }
    out.push({
      name: written.name,
      ...(skill.server ? { server: skill.server } : {}),
      sha: createHash("sha256").update(skill.body).digest("hex"),
    });
  }
  return out;
}

/** Remove the managed skills `record` lists. */
function removeSkills(runtime: Runtime, owner: PluginOwner, record: InstalledPluginRecord): void {
  const roots = managedSkillRoots(runtime.getWorkDir(), owner);
  for (const skill of record.skills) {
    const connector = skill.server
      ? record.connectors.find((c) => c.key === skill.server)
      : undefined;
    try {
      removeManagedSkill({
        roots,
        address: record.address,
        name: skill.name,
        ...(connector ? { serverName: connectionOf(connector) } : {}),
      });
    } catch (e) {
      log.warn(`[plugins] ${record.address}: skill "${skill.name}" could not be removed: ${e}`);
    }
  }
}

function recordOf(
  entry: ListedEntry,
  digest: string,
  contents: PluginContents,
  skills: InstalledPluginSkill[],
  installedAt: string,
  updatedAt?: string,
): InstalledPluginRecord {
  return {
    address: entry.address,
    digest,
    type: entry.type,
    installedAt,
    ...(updatedAt ? { updatedAt } : {}),
    connectors: contents.servers.map((s) => ({ key: s.key, name: s.name, server: s.detail })),
    skills,
    starters: contents.starters,
  };
}

/** Install the item at `address` for `owner`. */
export function installPlugin(
  ctx: PluginInstallContext,
  owner: PluginOwner,
  address: string,
): Promise<ToolResult> {
  return oneAtATime(owner, () => installPluginNow(ctx, owner, address));
}

async function installPluginNow(
  ctx: PluginInstallContext,
  owner: PluginOwner,
  address: string,
): Promise<ToolResult> {
  const refused = await ctx.ops.admit(owner);
  if (refused) return refused;
  const entry = await findListedEntry(ctx.runtime, address);
  if (!entry) {
    return err("NOT_IN_CATALOG", `"${address}" is not listed by any of this instance's catalogs.`);
  }
  const store = ctx.runtime.getPluginRecords();
  const records = await store.list(owner);
  const prior = records.find((r) => r.address === address);
  if (prior && prior.digest !== entry.digest) {
    return err(
      "UPDATE_AVAILABLE",
      `${address} is installed at ${prior.digest}, and its catalog now lists ${entry.digest}. Update it with update_plugin.`,
    );
  }

  const fetched = await fetchContents(ctx, entry);
  if ("isError" in fetched) return fetched;
  const { contents, digest } = fetched;

  const connected = await connectAll(ctx, owner, address, contents, records);
  if ("isError" in connected) return connected;
  // Converge first, then write the record: a rerun of a stopped install lands here again.
  const skills = materializeSkills(ctx.runtime, owner, address, contents);
  const record = recordOf(
    entry,
    digest,
    contents,
    skills,
    prior?.installedAt ?? new Date().toISOString(),
  );
  await store.put(owner, record);

  const alreadyInstalled = !!prior && connected.connected.every((c) => c.alreadyInstalled);
  return installedResult(owner, address, digest, connected.connected, skills, alreadyInstalled);
}

function installedResult(
  owner: PluginOwner,
  address: string,
  digest: string,
  connected: Array<{ serverName: string; warning?: string }>,
  skills: InstalledPluginSkill[],
  alreadyInstalled: boolean,
): ToolResult {
  const serverNames = connected.map((c) => c.serverName);
  const warning = connected
    .map((c) => c.warning)
    .filter(Boolean)
    .join(" ");
  const what = [
    serverNames.length > 0 ? `${serverNames.length} connector(s)` : "",
    skills.length > 0 ? `${skills.length} skill(s)` : "",
  ]
    .filter(Boolean)
    .join(" and ");
  const connect = serverNames.length > 0 ? " Connect it to authenticate." : "";
  return {
    content: textContent(
      `${alreadyInstalled ? "Already installed" : "Installed"} ${address}${what ? ` (${what})` : ""}.${connect}${warning ? ` ${warning}` : ""}`,
    ),
    structuredContent: {
      ok: true,
      alreadyInstalled,
      address,
      ...(serverNames[0] ? { serverName: serverNames[0] } : {}),
      serverNames,
      skills: skills.map((s) => s.name),
      digest,
      ...ownerFields(owner),
      ...(warning ? { warning } : {}),
    },
    isError: false,
  };
}

/** Remove one connection this record lists unless `others` name it; reports what happened. */
async function releaseConnections(
  ctx: PluginInstallContext,
  owner: PluginOwner,
  names: string[],
  others: InstalledPluginRecord[],
): Promise<{ removed: string[]; kept: string[] } | ToolResult> {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const name of names) {
    const serverName = connectionOf({ name });
    if (others.some((r) => r.connectors.some((c) => c.name === name))) {
      kept.push(serverName);
      continue;
    }
    // A connection no plugin created is its owner's, whatever record names it.
    if (!(await ctx.ops.existing(owner, serverName))?.installedBy) continue;
    const result = await ctx.ops.disconnect(owner, serverName);
    if (result.isError) return result;
    removed.push(serverName);
  }
  return { removed, kept };
}

/** Uninstall the plugin at `address` from `owner`. */
export function uninstallPlugin(
  ctx: PluginInstallContext,
  owner: PluginOwner,
  address: string,
): Promise<ToolResult> {
  return oneAtATime(owner, () => uninstallPluginNow(ctx, owner, address));
}

async function uninstallPluginNow(
  ctx: PluginInstallContext,
  owner: PluginOwner,
  address: string,
): Promise<ToolResult> {
  const refused = await ctx.ops.admit(owner);
  if (refused) return refused;
  const store = ctx.runtime.getPluginRecords();
  const records = await store.list(owner);
  const record = records.find((r) => r.address === address);
  if (!record) return err("NOT_INSTALLED", `${address} is not installed here.`);
  const others = records.filter((r) => r !== record);

  removeSkills(ctx.runtime, owner, record);
  const released = await releaseConnections(
    ctx,
    owner,
    record.connectors.map((c) => c.name),
    others,
  );
  if ("isError" in released) return released;
  await store.remove(owner, address);

  const parts = [`Uninstalled ${address}.`];
  if (released.kept.length > 0) {
    parts.push(`Kept ${released.kept.join(", ")}: another installed plugin uses it.`);
  }
  return {
    content: textContent(parts.join(" ")),
    structuredContent: {
      ok: true,
      address,
      removedConnectors: released.removed,
      keptConnectors: released.kept,
      removedSkills: record.skills.map((s) => s.name),
      ...ownerFields(owner),
    },
    isError: false,
  };
}

/** Update the plugin at `address` for `owner` to what its catalog lists now. */
export function updatePlugin(
  ctx: PluginInstallContext,
  owner: PluginOwner,
  address: string,
): Promise<ToolResult> {
  return oneAtATime(owner, () => updatePluginNow(ctx, owner, address));
}

async function updatePluginNow(
  ctx: PluginInstallContext,
  owner: PluginOwner,
  address: string,
): Promise<ToolResult> {
  const refused = await ctx.ops.admit(owner);
  if (refused) return refused;
  const store = ctx.runtime.getPluginRecords();
  const records = await store.list(owner);
  const record = records.find((r) => r.address === address);
  if (!record) return err("NOT_INSTALLED", `${address} is not installed here.`);
  const entry = await findListedEntry(ctx.runtime, address);
  if (!entry) {
    return err(
      "NOT_OFFERED",
      `${address} is no longer offered by its catalog; it stays installed at ${record.digest}.`,
    );
  }
  if (entry.digest === record.digest) {
    return {
      content: textContent(`${address} is up to date.`),
      structuredContent: {
        ok: true,
        address,
        updated: false,
        digest: record.digest,
        ...ownerFields(owner),
      },
      isError: false,
    };
  }

  const fetched = await fetchContents(ctx, entry);
  if ("isError" in fetched) return fetched;
  const { contents, digest } = fetched;
  const others = records.filter((r) => r !== record);

  // A server's record is its first supplier's in install order: this plugin
  // moves a connection only where that is itself (or nobody yet). Its current
  // record says what the connection was set up from until the new one lands.
  const suppliesIt = (name: string) => {
    const supplier = records.find((r) => r.connectors.some((c) => c.name === name));
    if (supplier && supplier !== record) return { reconfigure: false };
    const was = record.connectors.find((c) => c.name === name);
    const previous = was ? projectServerDetailToCatalogListing(was.server) : null;
    return { reconfigure: true, ...(previous ? { previous } : {}) };
  };
  const connected = await connectAll(ctx, owner, address, contents, records, suppliesIt);
  if ("isError" in connected) return connected;
  const dropped = record.connectors
    .map((c) => c.name)
    .filter((name) => !contents.servers.some((s) => s.name === name));
  removeSkills(ctx.runtime, owner, record);
  const released = await releaseConnections(ctx, owner, dropped, others);
  if ("isError" in released) return released;
  const skills = materializeSkills(ctx.runtime, owner, address, contents);
  await store.put(
    owner,
    recordOf(entry, digest, contents, skills, record.installedAt, new Date().toISOString()),
  );
  return {
    content: textContent(`Updated ${address} to ${digest}.${reconnectedNote(connected.connected)}`),
    structuredContent: {
      ok: true,
      address,
      updated: true,
      from: record.digest,
      digest,
      removedConnectors: released.removed,
      reconnectedConnectors: connected.connected
        .filter((c) => c.reconnected)
        .map((c) => c.serverName),
      serverNames: connected.connected.map((c) => c.serverName),
      skills: skills.map((s) => s.name),
      ...ownerFields(owner),
    },
    isError: false,
  };
}

function reconnectedNote(connected: Connected[]): string {
  const moved = connected.filter((c) => c.reconnected).map((c) => c.serverName);
  return moved.length > 0
    ? ` ${moved.join(", ")} now connect with updated settings; connect again to sign in.`
    : "";
}
