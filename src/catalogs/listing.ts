/**
 * Reading one AI Catalog document (the AI Catalog specification, 0.9) into the
 * entries a NimbleBrain host lists.
 *
 * Bytes in, entries plus diagnostics out; no I/O. The document must be an AI
 * Catalog this host can read: an object with a `specVersion` whose major is
 * one it supports and an `entries` array. A document that is not is refused
 * whole (`ListingDocumentError`), so the caller keeps its last good copy. One
 * bad entry is dropped with a diagnostic and the rest still load:
 *
 * - the entry's own shape: `identifier` and `type` strings, exactly one of
 *   `url` and `data`, optional `displayName`, `description`, `tags`, a `digest`
 *   in `algorithm:lowercase-hex` form with an algorithm at least SHA-256;
 * - its `extensions["ai.nimblebrain"]`, against the catalog-entry extension
 *   schema (`schemas/catalog-entry-extension/v1/`), and an `iconUrl` that is
 *   http(s), because Browse renders it as an image source;
 * - a name (`name@catalog`) another entry of the same catalog already has.
 *
 * Unrecognized members are ignored, as the specification requires.
 */

import { readFileSync } from "node:fs";
import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { isHttpUrl } from "../util/url.ts";
import {
  CATALOG_ENTRY_EXTENSION_SCHEMA_FILE,
  type CatalogEntryExtension,
  type CatalogEntryServer,
  NIMBLEBRAIN_EXTENSION_KEY,
} from "./entry-extension.ts";

/** The `specVersion` majors this reader understands. */
export const SUPPORTED_SPEC_MAJORS = ["0"] as const;

/** An Agent Plugin bundle, the type NimbleBrain's catalog lists. */
export const PLUGIN_TYPES = ["application/agent-plugins+zip", "application/agent-plugins+gzip"];

/** A connector listed on its own: inline `data` is its MCP Registry `server.json` record (ADR-0077). */
export const SERVER_RECORD_TYPE = "application/vnd.nimblebrain.server+json";

/** A skill listed on its own: an Agent Skills zip, or one `SKILL.md`. */
export const SKILL_TYPES = ["application/agent-skills+zip", "application/agent-skills+md"];

/** One listed item, as the host reads it. */
export interface ListedEntry {
  /** The catalog it came from. */
  catalog: string;
  /** Its short name within that catalog: the `urn:air` `{name}`, else the identifier's last segment. */
  name: string;
  /** `name@catalog`, unique within an instance. */
  address: string;
  identifier: string;
  type: string;
  /** The entry's `displayName`, else its name. */
  displayName: string;
  description?: string;
  tags?: string[];
  url?: string;
  /** Whether the entry carries its artifact inline. */
  inline: boolean;
  /** The inline artifact, when the entry carries one: what install verifies against `digest`. */
  data?: unknown;
  digest?: string;
  iconUrl?: string;
  category?: string;
  nimblebrainOnly?: boolean;
  /** Server key to registry name and auth, from the extension; empty when it names none. */
  servers: Record<string, CatalogEntryServer>;
}

/** Something wrong with one entry, which was dropped. */
export interface ListingDiagnostic {
  /** The entry's position in its document; absent for one dropped across catalogs. */
  index?: number;
  identifier?: string;
  message: string;
}

export interface ParsedListing {
  entries: ListedEntry[];
  diagnostics: ListingDiagnostic[];
}

/** A document that is not an AI Catalog this host can read. */
export class ListingDocumentError extends Error {}

let extensionValidator: ValidateFunction | null = null;

function validateExtension(): ValidateFunction {
  if (!extensionValidator) {
    const schema = JSON.parse(readFileSync(CATALOG_ENTRY_EXTENSION_SCHEMA_FILE, "utf-8"));
    extensionValidator = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  }
  return extensionValidator;
}

/** Parse and validate one AI Catalog document from `catalog`. Throws `ListingDocumentError`. */
export function parseListing(catalog: string, bytes: Uint8Array): ParsedListing {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new ListingDocumentError(`not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(doc)) throw new ListingDocumentError("not a JSON object");
  const specVersion = doc.specVersion;
  if (typeof specVersion !== "string" || !/^\d+\.\d+$/.test(specVersion)) {
    throw new ListingDocumentError('no "specVersion" in "Major.Minor" form');
  }
  const major = specVersion.split(".")[0] ?? "";
  if (!(SUPPORTED_SPEC_MAJORS as readonly string[]).includes(major)) {
    throw new ListingDocumentError(
      `specVersion ${specVersion} is a major this host does not read (it reads ${SUPPORTED_SPEC_MAJORS.map((m) => `${m}.x`).join(", ")})`,
    );
  }
  if (!Array.isArray(doc.entries)) throw new ListingDocumentError('no "entries" array');

  const entries: ListedEntry[] = [];
  const diagnostics: ListingDiagnostic[] = [];
  const names = new Set<string>();
  doc.entries.forEach((raw, index) => {
    const result = readEntry(catalog, raw);
    if (typeof result === "string") {
      const identifier =
        isObject(raw) && typeof raw.identifier === "string" ? raw.identifier : undefined;
      diagnostics.push({ index, ...(identifier ? { identifier } : {}), message: result });
      return;
    }
    if (names.has(result.name)) {
      diagnostics.push({
        index,
        identifier: result.identifier,
        message: `its name "${result.name}" is another entry's in this catalog`,
      });
      return;
    }
    names.add(result.name);
    entries.push(result);
  });
  return { entries, diagnostics };
}

/** The fields of an entry this host reads, once its shape is known good. */
interface EntryShape {
  identifier: string;
  type: string;
  displayName?: string;
  description?: string;
  tags?: string[];
  url?: string;
  data?: unknown;
  digest?: string;
  extensions?: Record<string, unknown>;
}

/** One entry, or why it was dropped. */
function readEntry(catalog: string, raw: unknown): ListedEntry | string {
  const shape = entryShapeViolation(raw);
  if (shape) return shape;
  const e = raw as EntryShape;
  const extension = readExtension(e.extensions?.[NIMBLEBRAIN_EXTENSION_KEY]);
  if (typeof extension === "string") return extension;
  const name = nameOf(e.identifier);
  if (!name) return `no name can be read from identifier "${e.identifier}"`;
  const category = extension.category?.trim();
  return {
    catalog,
    name,
    address: `${name}@${catalog}`,
    identifier: e.identifier,
    type: e.type,
    displayName: e.displayName?.trim() ? e.displayName : name,
    ...(e.description !== undefined ? { description: e.description } : {}),
    ...(e.tags && e.tags.length > 0 ? { tags: e.tags } : {}),
    ...(e.url !== undefined ? { url: e.url } : {}),
    inline: e.data !== undefined,
    ...(e.data !== undefined ? { data: e.data } : {}),
    ...(e.digest !== undefined ? { digest: e.digest } : {}),
    ...(extension.iconUrl ? { iconUrl: extension.iconUrl } : {}),
    ...(category ? { category } : {}),
    ...(extension.nimblebrainOnly === true ? { nimblebrainOnly: true } : {}),
    servers: extension.servers ?? {},
  };
}

/** Why an entry is not a Catalog Entry this host reads, or null when it is. */
function entryShapeViolation(raw: unknown): string | null {
  if (!isObject(raw)) return "not an object";
  if (!nonEmptyString(raw.identifier)) return 'no "identifier"';
  if (!nonEmptyString(raw.type)) return 'no "type"';
  return artifactViolation(raw) ?? optionalFieldViolation(raw);
}

/** Exactly one of `url` (http(s)) and `data`. */
function artifactViolation(raw: Record<string, unknown>): string | null {
  if ((raw.url === undefined) === (raw.data === undefined)) {
    return 'needs exactly one of "url" and "data"';
  }
  if (raw.url !== undefined && !(typeof raw.url === "string" && isHttpUrl(raw.url))) {
    return '"url" must be an http(s) URL';
  }
  return null;
}

/** The optional members this host reads, each of its type when present. */
function optionalFieldViolation(raw: Record<string, unknown>): string | null {
  for (const field of ["displayName", "description"] as const) {
    if (raw[field] !== undefined && typeof raw[field] !== "string") {
      return `"${field}" must be a string`;
    }
  }
  const tags = raw.tags;
  if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === "string"))) {
    return '"tags" must be an array of strings';
  }
  const digest = raw.digest === undefined ? null : digestViolation(raw.digest);
  if (digest) return digest;
  if (raw.extensions !== undefined && !isObject(raw.extensions)) {
    return '"extensions" must be an object';
  }
  return null;
}

/** The entry's extension, validated against its schema, or why it is invalid. */
function readExtension(ext: unknown): CatalogEntryExtension | string {
  if (ext === undefined) return {};
  const validate = validateExtension();
  const where = `extensions["${NIMBLEBRAIN_EXTENSION_KEY}"]`;
  if (!validate(ext)) {
    const why = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`)
      .join("; ");
    return `${where} is invalid: ${why}`;
  }
  const extension = ext as CatalogEntryExtension;
  if (extension.iconUrl !== undefined && !isHttpUrl(extension.iconUrl)) {
    return `${where}.iconUrl must be http(s)`;
  }
  return extension;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * An entry's short name: for `urn:air:{publisher}:{name}[:{kind}]` the whole
 * `{name}`, otherwise the part after the last `:` or `/` (the specification's
 * display-name fallback).
 */
export function nameOf(identifier: string): string {
  const urn = /^urn:air:[^:]+:([^:]+)(?::[^:]+)?$/i.exec(identifier);
  if (urn) return urn[1] ?? "";
  const parts = identifier.split(/[:/]/);
  return parts[parts.length - 1] ?? "";
}

/** Algorithms the specification allows: SHA-256 or stronger. */
const DIGEST_ALGORITHMS: Record<string, number> = { sha256: 64, sha384: 96, sha512: 128 };

function digestViolation(digest: unknown): string | null {
  if (typeof digest !== "string") return '"digest" must be a string';
  const m = /^([a-z0-9-]+):([0-9a-f]+)$/.exec(digest);
  if (!m) return `"digest" must be algorithm:lowercase-hex, got "${digest}"`;
  const length = DIGEST_ALGORITHMS[m[1] ?? ""];
  if (length === undefined) return `"digest" uses ${m[1]}, which is not SHA-256 or stronger`;
  if ((m[2] ?? "").length !== length) return `"digest" is not a whole ${m[1]} value`;
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
