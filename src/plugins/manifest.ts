/**
 * The one reader of a plugin's manifest (ADR-0068, ADR-0076).
 *
 * A plugin is an Agent Plugins 1.0.0 directory: `plugin.json` at its root,
 * its MCP servers in `mcp.json`, its skills in `skills/<name>/SKILL.md`.
 * NimbleBrain's own fields sit under `extensions["ai.nimblebrain"]`
 * (`./extension.ts`). A catalog plugin and a system plugin are the same
 * format, read here.
 *
 * Two entry points, one set of rules about what the fields mean:
 *
 * - {@link parsePluginManifest} loads a plugin the operator configured. It
 *   validates `plugin.json` and `mcp.json` against the format's own schemas
 *   (vendored in `./schemas/`, never fetched), the extension against its
 *   published schema, and the rules the format states in prose (a stdio
 *   `command` is one token, `cwd` stays inside its root, a remote URL is
 *   HTTPS off loopback). Any violation throws a {@link PluginManifestError}
 *   naming the plugin, the file and each field. An unknown top-level field of
 *   `plugin.json` is reported and ignored, as the format requires.
 * - {@link nimblebrainExtension} reads the extension of a manifest that a
 *   pinned catalog already vouches for. It keeps each well-formed field and
 *   drops a malformed one, so one bad entry from a catalog never fails the
 *   whole read.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import extensionSchema from "../../schemas/plugin-extension/v1/plugin-extension.schema.json";
import {
  type ContractImplementation,
  type ContractRequirement,
  type ConversationStarter,
  MAX_CONVERSATION_STARTERS,
  MAX_STARTER_TEXT,
  MAX_STARTER_TITLE,
} from "./extension.ts";
import mcpSchema from "./schemas/agent-plugins-1.0.0-mcp.schema.json";
import pluginSchema from "./schemas/agent-plugins-1.0.0-plugin.schema.json";

/** The manifest's path inside a plugin. */
export const PLUGIN_MANIFEST_FILE = "plugin.json";
/** The MCP configuration's path inside a plugin. */
export const MCP_CONFIG_FILE = "mcp.json";
/** The `extensions` key NimbleBrain reads. */
export const NIMBLEBRAIN_EXTENSION = "ai.nimblebrain";

/** A plugin's files, keyed by their path inside the plugin (`plugin.json`, `skills/x/SKILL.md`). */
export type PluginFiles = ReadonlyMap<string, Uint8Array>;

/** Where a plugin's placeholders point: `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`, both absolute. */
export interface PluginPaths {
  root: string;
  data: string;
}

/** One violation: the file, the field inside it (empty for the whole file), and what is wrong. */
export interface PluginProblem {
  file: string;
  field: string;
  message: string;
}

/** A plugin that cannot be loaded, with every violation found. */
export class PluginManifestError extends Error {
  constructor(
    readonly plugin: string,
    readonly problems: PluginProblem[],
  ) {
    super(`plugin ${plugin}: ${problems.map(formatProblem).join("; ")}`);
    this.name = "PluginManifestError";
  }
}

export function formatProblem(p: PluginProblem): string {
  return p.field ? `${p.file} ${p.field}: ${p.message}` : `${p.file}: ${p.message}`;
}

/** A server the runtime starts: `command` resolved against the root when `./`-relative, placeholders expanded. */
export interface StdioServer {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Absolute; the plugin root when the server names none. */
  cwd: string;
}

/** A server the runtime reaches over Streamable HTTP. */
export interface HttpServer {
  type: "streamable-http";
  url: string;
  headers: Record<string, string>;
}

export type PluginServer = StdioServer | HttpServer;

/** The `ai.nimblebrain` extension as read: every field present, empty when the manifest has none. */
export interface NimbleBrainExtension {
  /** Server key → registry name. */
  servers: Record<string, string>;
  conversationStarters: ConversationStarter[];
  nimblebrainOnly: boolean;
  implements: ContractImplementation[];
  requires: ContractRequirement[];
}

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  /** `mcp.json`'s servers by key; empty when the plugin has no `mcp.json`. */
  mcpServers: Record<string, PluginServer>;
  /** Each skill's folder inside the plugin (`skills/<name>`), sorted. */
  skills: string[];
  extension: NimbleBrainExtension;
  /** Violations the format says to report and ignore (an unknown top-level field). */
  warnings: string[];
}

// ── Reading files ────────────────────────────────────────────────────────

/**
 * The files of a plugin directory the reader uses: `plugin.json`, `mcp.json`
 * and each `skills/<name>/SKILL.md`. Nothing else is read.
 */
export function readPluginDirectory(root: string): PluginFiles {
  const files = new Map<string, Uint8Array>();
  for (const name of [PLUGIN_MANIFEST_FILE, MCP_CONFIG_FILE]) {
    const path = join(root, name);
    if (existsSync(path)) files.set(name, readFileSync(path));
  }
  const skillsDir = join(root, "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      const skill = join(skillsDir, entry.name, "SKILL.md");
      if (entry.isDirectory() && existsSync(skill)) {
        files.set(`skills/${entry.name}/SKILL.md`, readFileSync(skill));
      }
    }
  }
  return files;
}

/** Parse one JSON file of a plugin, or throw naming the plugin and the file. */
export function readPluginJson(plugin: string, file: string, bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new PluginManifestError(plugin, [
      { file, field: "", message: `not valid JSON (${(err as Error).message})` },
    ]);
  }
}

// ── The extension, leniently ─────────────────────────────────────────────

/**
 * The `ai.nimblebrain` extension of a parsed manifest, keeping each
 * well-formed field and dropping a malformed one: a server whose registry name
 * is not a string, a starter without a title and text within the limits
 * (trimmed, at most {@link MAX_CONVERSATION_STARTERS}), an implementation or
 * requirement missing its contract or version. A manifest with no extension
 * reads as an empty one: no servers, no starters, no contracts.
 */
export function nimblebrainExtension(manifest: unknown): NimbleBrainExtension {
  const raw = field(field(manifest, "extensions"), NIMBLEBRAIN_EXTENSION);
  return {
    servers: stringRecord(field(raw, "servers")),
    conversationStarters: readConversationStarters(field(raw, "conversationStarters")),
    nimblebrainOnly: field(raw, "nimblebrainOnly") === true,
    implements: arrayOf(field(raw, "implements")).flatMap((item) => {
      const contract = field(item, "contract");
      const version = field(item, "version");
      if (typeof contract !== "string" || typeof version !== "string") return [];
      const server = field(item, "server");
      if (typeof server !== "string") return [];
      return [{ contract, version, server }];
    }),
    requires: arrayOf(field(raw, "requires")).flatMap((item) => {
      const contract = field(item, "contract");
      const version = field(item, "version");
      if (typeof contract !== "string" || typeof version !== "string") return [];
      return [
        { contract, version, ...(field(item, "optional") === true ? { optional: true } : {}) },
      ];
    }),
  };
}

function readConversationStarters(raw: unknown): ConversationStarter[] {
  const out: ConversationStarter[] = [];
  for (const item of arrayOf(raw)) {
    const title = field(item, "title");
    const text = field(item, "text");
    if (typeof title !== "string" || typeof text !== "string") continue;
    const t = title.trim();
    const x = text.trim();
    if (!t || !x || t.length > MAX_STARTER_TITLE || x.length > MAX_STARTER_TEXT) continue;
    out.push({ title: t, text: x });
    if (out.length === MAX_CONVERSATION_STARTERS) break;
  }
  return out;
}

// ── The manifest, strictly ───────────────────────────────────────────────

interface Validators {
  plugin: ValidateFunction;
  extension: ValidateFunction;
  stdio: ValidateFunction;
  http: ValidateFunction;
  mcp: ValidateFunction;
}

let validators: Validators | null = null;

function compiled(): Validators {
  if (validators) return validators;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(mcpSchema);
  const def = (name: string) => {
    const fn = ajv.getSchema(`${mcpSchema.$id}#/$defs/${name}`);
    if (!fn) throw new Error(`the vendored mcp.json schema has no $defs/${name}`);
    return fn;
  };
  validators = {
    plugin: ajv.compile(pluginSchema),
    extension: ajv.compile(extensionSchema),
    mcp: ajv.getSchema(mcpSchema.$id) as ValidateFunction,
    stdio: def("stdioServer"),
    http: def("streamableHttpServer"),
  };
  return validators;
}

/**
 * Parse and validate a plugin from its files: a directory read by
 * {@link readPluginDirectory}, or an archive's entries. `plugin` names it in
 * errors (the operator's key for it); `paths` are where its placeholders
 * point. Throws {@link PluginManifestError} with every violation found.
 */
export function parsePluginManifest(
  plugin: string,
  files: PluginFiles,
  paths: PluginPaths,
): PluginManifest {
  const bytes = files.get(PLUGIN_MANIFEST_FILE);
  if (!bytes) {
    throw new PluginManifestError(plugin, [
      {
        file: PLUGIN_MANIFEST_FILE,
        field: "",
        message: "missing: an Agent Plugin has plugin.json at its root",
      },
    ]);
  }
  const manifest = readPluginJson(plugin, PLUGIN_MANIFEST_FILE, bytes);
  const { problems, warnings, extensionsUsable } = manifestSchemaProblems(manifest);

  const rawExtension = extensionsUsable
    ? field(field(manifest, "extensions"), NIMBLEBRAIN_EXTENSION)
    : undefined;
  const extensionField = `extensions["${NIMBLEBRAIN_EXTENSION}"]`;
  if (rawExtension !== undefined) problems.push(...extensionProblems(rawExtension, extensionField));

  const mcpServers = readMcpConfig(files, paths, problems);
  const extension = nimblebrainExtension(extensionsUsable ? manifest : undefined);
  if (rawExtension !== undefined && problems.length === 0) {
    problems.push(...crossCheckExtension(extension, mcpServers, extensionField));
  }
  if (problems.length > 0) throw new PluginManifestError(plugin, problems);

  const version = field(manifest, "version");
  const description = field(manifest, "description");
  return {
    name: field(manifest, "name") as string,
    ...(typeof version === "string" ? { version } : {}),
    ...(typeof description === "string" ? { description } : {}),
    mcpServers,
    skills: skillFolders(files),
    extension,
    warnings,
  };
}

/**
 * An `ai.nimblebrain` extension object against its published schema, wherever
 * it appears (a manifest's `extensions`, an AI Catalog entry's). `at` prefixes
 * each problem's field. Empty when it is valid.
 */
export function extensionProblems(raw: unknown, at = ""): PluginProblem[] {
  const v = compiled();
  if (v.extension(raw)) return [];
  return (v.extension.errors ?? []).map((e) => schemaProblem(PLUGIN_MANIFEST_FILE, at, e));
}

/**
 * `plugin.json` against the format's schema. The format makes an unknown
 * top-level field, and a non-object `extensions`, non-fatal: reported and
 * ignored. Every other violation refuses the plugin.
 */
function manifestSchemaProblems(manifest: unknown): {
  problems: PluginProblem[];
  warnings: string[];
  extensionsUsable: boolean;
} {
  const out = { problems: [] as PluginProblem[], warnings: [] as string[], extensionsUsable: true };
  const v = compiled();
  if (v.plugin(manifest)) return out;
  for (const e of v.plugin.errors ?? []) {
    if (e.instancePath === "" && e.keyword === "additionalProperties") {
      out.warnings.push(`${PLUGIN_MANIFEST_FILE}: unknown field "${unknownField(e)}" ignored`);
    } else if (e.instancePath === "/extensions" && e.keyword === "type") {
      out.warnings.push(`${PLUGIN_MANIFEST_FILE}: "extensions" is not an object; ignored`);
      out.extensionsUsable = false;
    } else {
      out.problems.push(schemaProblem(PLUGIN_MANIFEST_FILE, "", e));
    }
  }
  return out;
}

/** Each `skills/<name>` folder that holds a `SKILL.md`, sorted. */
function skillFolders(files: PluginFiles): string[] {
  return [...files.keys()]
    .flatMap((p) => {
      const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(p);
      return m ? [`skills/${m[1]}`] : [];
    })
    .sort();
}

/**
 * The extension's references, which no schema can check: each contract is
 * implemented once, by a server the plugin's mcp.json declares.
 */
function crossCheckExtension(
  extension: NimbleBrainExtension,
  mcpServers: Record<string, PluginServer>,
  at: string,
): PluginProblem[] {
  const problems: PluginProblem[] = [];
  const seen = new Set<string>();
  extension.implements.forEach((impl, i) => {
    if (seen.has(impl.contract)) {
      problems.push({
        file: PLUGIN_MANIFEST_FILE,
        field: `${at}.implements[${i}].contract`,
        message: `${impl.contract} is implemented twice`,
      });
    }
    seen.add(impl.contract);
    if (!Object.hasOwn(mcpServers, impl.server)) {
      problems.push({
        file: PLUGIN_MANIFEST_FILE,
        field: `${at}.implements[${i}].server`,
        message: `"${impl.server}" is not a server in mcp.json`,
      });
    }
  });
  return problems;
}

// ── mcp.json ─────────────────────────────────────────────────────────────

function readMcpConfig(
  files: PluginFiles,
  paths: PluginPaths,
  problems: PluginProblem[],
): Record<string, PluginServer> {
  const bytes = files.get(MCP_CONFIG_FILE);
  if (!bytes) return {};
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    problems.push({
      file: MCP_CONFIG_FILE,
      field: "",
      message: `not valid JSON (${(err as Error).message})`,
    });
    return {};
  }
  const v = compiled();
  // The whole document against the format's schema, except each server, which
  // is checked against the one variant its `type` selects so its errors name
  // that variant's fields rather than every variant's.
  if (!v.mcp(doc)) {
    for (const e of v.mcp.errors ?? []) {
      if (!e.instancePath.startsWith("/mcpServers/"))
        problems.push(schemaProblem(MCP_CONFIG_FILE, "", e));
    }
  }
  const out = nameMap<PluginServer>();
  for (const [key, spec] of Object.entries(objectOf(field(doc, "mcpServers")))) {
    const server = readServer(key, spec, paths, problems);
    if (server) out[key] = server;
  }
  return out;
}

function readServer(
  key: string,
  spec: unknown,
  paths: PluginPaths,
  problems: PluginProblem[],
): PluginServer | null {
  const at = `mcpServers.${key}`;
  const fail = (message: string, sub = "") => {
    problems.push({ file: MCP_CONFIG_FILE, field: sub ? `${at}.${sub}` : at, message });
    return null;
  };
  const type = field(spec, "type");
  const v = compiled();
  if (type === "sse") {
    return fail("the sse transport is not supported; use streamable-http", "type");
  }
  if (type === "stdio") {
    if (!v.stdio(spec)) {
      for (const e of v.stdio.errors ?? []) problems.push(schemaProblem(MCP_CONFIG_FILE, at, e));
      return null;
    }
    return readStdioServer(spec as RawStdio, paths, fail);
  }
  if (type === "streamable-http") {
    if (!v.http(spec)) {
      for (const e of v.http.errors ?? []) problems.push(schemaProblem(MCP_CONFIG_FILE, at, e));
      return null;
    }
    return readHttpServer(spec as RawHttp, fail);
  }
  return fail('must be "stdio" or "streamable-http"', "type");
}

interface RawStdio {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface RawHttp {
  url: string;
  headers?: Record<string, string>;
}

type Fail = (message: string, sub?: string) => null;

/** The format's prose rules for a stdio server, then its placeholders expanded. */
function readStdioServer(spec: RawStdio, paths: PluginPaths, fail: Fail): StdioServer | null {
  const c = spec.command;
  if (/\s/.test(c)) return fail("must be one executable token; arguments go in args", "command");
  if (isAbsolute(c)) return fail("must be a bare name or ./-relative, not absolute", "command");
  if (c.includes("/") && !c.startsWith("./")) {
    return fail("must be a bare name or start with ./", "command");
  }
  if (c.split("/").includes("..")) return fail("must stay inside the plugin", "command");

  let cwd = paths.root;
  if (spec.cwd !== undefined) {
    const expanded = expandPluginVars(spec.cwd, paths);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the format's literal placeholder
    const base = spec.cwd.startsWith("${PLUGIN_DATA}") ? paths.data : paths.root;
    cwd = resolve(paths.root, expanded);
    if (!within(base, cwd)) return fail("must stay inside the plugin's root or data", "cwd");
  }
  return {
    type: "stdio",
    command: c.startsWith("./") ? join(paths.root, c) : c,
    args: (spec.args ?? []).map((a) => expandPluginVars(a, paths)),
    env: Object.fromEntries(
      Object.entries(spec.env ?? {}).map(([k, val]) => [k, expandPluginVars(val, paths)]),
    ),
    cwd,
  };
}

/** The format's prose rules for a remote server. Nothing is expanded in a URL or header. */
function readHttpServer(spec: RawHttp, fail: Fail): HttpServer | null {
  const problem = remoteUrlProblem(spec.url);
  if (problem) return fail(problem, "url");
  const seen = new Set<string>();
  for (const name of Object.keys(spec.headers ?? {})) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) return fail(`"${name}" appears twice under different casing`, "headers");
    seen.add(lower);
  }
  return { type: "streamable-http", url: spec.url, headers: { ...(spec.headers ?? {}) } };
}

/**
 * Why a URL cannot name a remote MCP server, or null: it must be absolute
 * HTTP or HTTPS with no user information or fragment, and HTTPS unless its
 * host is loopback.
 */
export function remoteUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "must be an absolute URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "must be http or https";
  if (url.username || url.password) return "must not carry user information";
  if (url.hash) return "must not carry a fragment";
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    return "must be https unless its host is loopback";
  }
  return null;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` replaced in one string: a single,
 * non-recursive pass, as the format defines. Nothing else is expanded.
 */
export function expandPluginVars(value: string, paths: PluginPaths): string {
  return value.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g, (_, name: string) =>
    name === "PLUGIN_ROOT" ? paths.root : paths.data,
  );
}

function within(base: string, path: string): boolean {
  const rel = relative(base, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** An AJV error as a problem, its JSON pointer written as a field path under `at`. */
function schemaProblem(file: string, at: string, e: ErrorObject): PluginProblem {
  const path = e.instancePath
    .split("/")
    .slice(1)
    .map((seg) => seg.replaceAll("~1", "/").replaceAll("~0", "~"))
    .map((seg) => (/^\d+$/.test(seg) ? `[${seg}]` : `.${seg}`))
    .join("");
  const fieldPath = `${at}${path}`.replace(/^\./, "");
  if (e.keyword === "additionalProperties") {
    return { file, field: fieldPath, message: `unknown field "${unknownField(e)}"` };
  }
  if (e.keyword === "const") {
    const allowed = (e.params as { allowedValue: unknown }).allowedValue;
    return { file, field: fieldPath, message: `must be ${JSON.stringify(allowed)}` };
  }
  return { file, field: fieldPath, message: e.message ?? e.keyword };
}

function unknownField(e: ErrorObject): string {
  return (e.params as { additionalProperty: string }).additionalProperty;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * An empty map keyed by names a plugin author chose. It has no prototype, so a key such
 * as `__proto__` or `constructor` is stored and looked up like any other, and nothing
 * inherited ever reads as present. Look keys up with `Object.hasOwn`.
 */
export function nameMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function stringRecord(value: unknown): Record<string, string> {
  const out = nameMap<string>();
  for (const [key, name] of Object.entries(objectOf(value))) {
    if (typeof name === "string") out[key] = name;
  }
  return out;
}
