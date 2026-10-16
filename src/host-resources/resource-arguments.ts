import type { ReadResourceResult } from "@modelcontextprotocol/server";
import { UriTemplate } from "@modelcontextprotocol/server";
import { log } from "../observability/log.ts";
import { HOST_RESOURCES_MAX_READ_SIZE } from "./capability.ts";
import type { HostResourcesRateLimit } from "./rate-limit.ts";

/**
 * The `ai.nimblebrain/resource-arguments` extension: the host reads the
 * resources a tool's arguments name, from the connector in the same workspace
 * that serves them, and hands the contents to the tool with the call.
 *
 * One identifier in three places, the way `ai.nimblebrain/lifecycle` is one
 * identifier on a capability and a tool marker:
 *
 *   - the host's client capability, claimed on both eras by a workspace
 *     connector's connection (`resourceArgumentsClientExtension`);
 *   - the tool's `_meta`, where the tool names which arguments hold resource
 *     URIs and which schemes it accepts in each (`parseResourceArgumentsDeclaration`);
 *   - the `tools/call` request's `_meta`, where the host puts one entry per URI,
 *     resolved or not (`ResourceArgumentEntry`).
 *
 * Nothing travels from server to host, so the same mechanism works on a 2025-era
 * connection and on `2026-07-28`, which has no server-to-client requests.
 *
 * Developer contract: `docs/src/content/docs/extensions/resource-arguments.mdx`.
 */
export const RESOURCE_ARGUMENTS_EXTENSION_ID = "ai.nimblebrain/resource-arguments" as const;

/** Most distinct URIs resolved for one call. Each costs a read and a rate-limit token. */
export const RESOURCE_ARGUMENTS_MAX_URIS = 32;

/** The capability a workspace connector's connection claims: the limits a tool can plan around. */
export function resourceArgumentsClientExtension(): Record<
  string,
  { maxSize: number; maxUris: number }
> {
  return {
    [RESOURCE_ARGUMENTS_EXTENSION_ID]: {
      maxSize: HOST_RESOURCES_MAX_READ_SIZE,
      maxUris: RESOURCE_ARGUMENTS_MAX_URIS,
    },
  };
}

/** Argument name → the schemes (lowercase) the tool accepts in it. */
export type ResourceArgumentsDeclaration = ReadonlyMap<string, ReadonlySet<string>>;

/** RFC 3986 scheme grammar. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*$/;

/**
 * The declaration a tool's `_meta` carries, or null when it declares none.
 *
 * ```json
 * { "ai.nimblebrain/resource-arguments": { "arguments": { "<arg>": { "schemes": ["<scheme>"] } } } }
 * ```
 *
 * Lenient on what it does not know, strict on what it reads: an argument entry
 * without a non-empty `schemes` list of valid scheme names declares nothing, so
 * there is no wildcard and no way to ask the host for every scheme.
 */
export function parseResourceArgumentsDeclaration(
  meta: Record<string, unknown> | undefined,
): ResourceArgumentsDeclaration | null {
  const block = meta?.[RESOURCE_ARGUMENTS_EXTENSION_ID];
  if (!isRecord(block) || !isRecord(block.arguments)) return null;
  const declared = new Map<string, Set<string>>();
  for (const [name, spec] of Object.entries(block.arguments)) {
    if (!isRecord(spec) || !Array.isArray(spec.schemes)) continue;
    const schemes = new Set(
      spec.schemes
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.toLowerCase())
        .filter((s) => SCHEME_RE.test(s)),
    );
    if (schemes.size > 0) declared.set(name, schemes);
  }
  return declared.size > 0 ? declared : null;
}

/**
 * Every string a declared argument holds, in first-seen order, deduplicated,
 * each with whether its scheme is one the argument declares. Reads only the
 * top-level argument, as a string or an array of strings; anything else in it
 * is not a URI and is skipped.
 */
export function collectResourceArgumentUris(
  declaration: ResourceArgumentsDeclaration,
  args: Record<string, unknown>,
): { uri: string; declared: boolean }[] {
  const seen = new Map<string, boolean>();
  for (const [name, schemes] of declaration) {
    const value = args[name];
    const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    for (const v of values) {
      if (typeof v !== "string" || v.length === 0) continue;
      const scheme = schemeOf(v);
      const declared = scheme !== null && schemes.has(scheme);
      seen.set(v, (seen.get(v) ?? false) || declared);
    }
  }
  return [...seen].map(([uri, declared]) => ({ uri, declared }));
}

/** Why the host could not hand a URI's contents to the tool. */
export type ResourceArgumentErrorCode =
  | "scheme_not_declared"
  | "not_found"
  | "ambiguous"
  | "too_large"
  | "too_many"
  | "rate_limited";

/** One URI's entry in the call's `_meta`: the read result, or why there is none. */
export type ResourceArgumentEntry =
  | { contents: ReadResourceResult["contents"] }
  | { error: { code: ResourceArgumentErrorCode; message: string } };

/** URI → entry, as it rides in the call's `_meta[RESOURCE_ARGUMENTS_EXTENSION_ID]`. */
export type ResourceArgumentEntries = Record<string, ResourceArgumentEntry>;

/** A connector in the workspace, as resolution reads it. */
export interface ResourceServingSource {
  readonly name: string;
  /** The server's `resources/templates/list`. */
  resourceTemplates(): Promise<readonly { uriTemplate: string }[]>;
  /** The server's `resources/read` result contents, or null when it returned nothing or failed. */
  readResourceContents(
    uri: string,
    opts?: { signal?: AbortSignal },
  ): Promise<ReadResourceResult["contents"] | null>;
}

/** Who a resolution is for: the calling connector, in the workspace its connection belongs to. */
export interface ResourceArgumentsContext {
  workspaceId: string;
  connectorId: string;
  /**
   * False when the call runs inside an unattended run that may not read
   * connector resources itself: every declared URI is then `not_found` and
   * nothing is read.
   */
  mayRead?: boolean;
  signal?: AbortSignal;
}

/** Resolves a call's declared URIs. One per runtime, shared by every workspace connector. */
export interface ResourceArgumentsResolver {
  resolve(
    uris: readonly { uri: string; declared: boolean }[],
    ctx: ResourceArgumentsContext,
  ): Promise<ResourceArgumentEntries>;
}

export interface ResourceArgumentsResolverDeps {
  /**
   * The connectors of one workspace. Resolution looks nowhere else, so a
   * connector in another workspace can never answer, whatever it serves.
   */
  sourcesOf(workspaceId: string): readonly ResourceServingSource[];
  /** Whether the host resolves this URI's scheme itself (`files://`, `ui://`, …), so no connector may claim it. */
  isHostScheme(uri: string): boolean;
  /** The per-(workspace, connector) budget the host-resources methods spend from. */
  rateLimit: HostResourcesRateLimit;
  /** Byte cap on one URI's contents and on all of one call's together. */
  maxSize?: number;
  maxUris?: number;
}

const NOT_FOUND_MESSAGE = "No connector in this workspace returned this resource.";

/**
 * The resolver: for each declared URI, find the one connector in the calling
 * workspace whose resource templates the URI expands from, and read it there.
 *
 * Ownership is by template, never by asking every source until one answers
 * (the `ai.nimblebrain/open` rule): a connector cannot answer for a scheme it
 * does not advertise, and two claimants is a workspace defect reported as
 * `ambiguous` rather than guessed. The read runs in the request context of the
 * tool call, so the serving connector sees the same caller it would for the
 * agent's own read.
 *
 * "No connector serves it", "the read failed", and "the read returned nothing"
 * all collapse to `not_found`, as `ai.nimblebrain/resources/read` collapses
 * them: the calling connector learns nothing about what exists beyond the
 * contents it is handed. The real cause goes to the log.
 */
export function createResourceArgumentsResolver(
  deps: ResourceArgumentsResolverDeps,
): ResourceArgumentsResolver {
  const maxSize = deps.maxSize ?? HOST_RESOURCES_MAX_READ_SIZE;
  const maxUris = deps.maxUris ?? RESOURCE_ARGUMENTS_MAX_URIS;

  async function ownersOf(uri: string, sources: readonly ResourceServingSource[]) {
    if (deps.isHostScheme(uri)) return [];
    const claims = await Promise.all(
      sources.map(async (s) => {
        try {
          const templates = await s.resourceTemplates();
          return templates.some((t) => expandsFrom(t.uriTemplate, uri)) ? s : null;
        } catch {
          return null;
        }
      }),
    );
    return claims.filter((s): s is ResourceServingSource => s !== null);
  }

  async function readOne(
    uri: string,
    ctx: ResourceArgumentsContext,
    sources: readonly ResourceServingSource[],
  ): Promise<ResourceArgumentEntry> {
    if (ctx.mayRead === false) {
      debug(ctx, `${uri} → not read: the run's tool limit excludes resource reads`);
      return failure("not_found", NOT_FOUND_MESSAGE);
    }
    try {
      deps.rateLimit.check(ctx.workspaceId, ctx.connectorId);
    } catch {
      return failure("rate_limited", "Rate limited: this connector's resource budget is spent.");
    }
    const owners = await ownersOf(uri, sources);
    if (owners.length > 1) {
      return failure(
        "ambiguous",
        `More than one connector in this workspace serves this URI: ${owners.map((o) => o.name).join(", ")}.`,
      );
    }
    const owner = owners[0];
    if (!owner) {
      debug(ctx, `${uri} → no serving connector`);
      return failure("not_found", NOT_FOUND_MESSAGE);
    }
    const contents = await owner
      .readResourceContents(uri, ctx.signal ? { signal: ctx.signal } : undefined)
      .catch(() => null);
    if (!contents || contents.length === 0) {
      log.warn(
        `[resource-arguments] [${ctx.connectorId}:${ctx.workspaceId}] read ${uri} from ${owner.name} returned nothing (collapsing to not_found)`,
      );
      return failure("not_found", NOT_FOUND_MESSAGE);
    }
    debug(ctx, `${uri} → ${owner.name} (${contentsSize(contents)}B)`);
    return { contents };
  }

  return {
    async resolve(uris, ctx) {
      const entries: ResourceArgumentEntries = {};
      const declared: string[] = [];
      for (const { uri, declared: ok } of uris) {
        if (!ok) {
          entries[uri] = failure(
            "scheme_not_declared",
            "This argument does not declare the URI's scheme, so the host did not read it.",
          );
        } else if (declared.length >= maxUris) {
          entries[uri] = failure("too_many", `A call resolves at most ${maxUris} URIs.`);
        } else {
          declared.push(uri);
        }
      }
      if (declared.length === 0) return entries;

      const sources = deps.sourcesOf(ctx.workspaceId);
      const read = await Promise.all(declared.map((uri) => readOne(uri, ctx, sources)));

      // The budget is applied in argument order, so which entries fit does not
      // depend on which read finished first.
      let spent = 0;
      declared.forEach((uri, i) => {
        const entry = read[i] as ResourceArgumentEntry;
        if ("contents" in entry) {
          const size = contentsSize(entry.contents);
          if (size > maxSize || spent + size > maxSize) {
            entries[uri] = failure(
              "too_large",
              `The resolved contents of one call are capped at ${maxSize} bytes; this resource is ${size}.`,
            );
            return;
          }
          spent += size;
        }
        entries[uri] = entry;
      });
      return entries;
    },
  };
}

function failure(code: ResourceArgumentErrorCode, message: string): ResourceArgumentEntry {
  return { error: { code, message } };
}

function debug(ctx: ResourceArgumentsContext, line: string): void {
  log.debug(
    "host-resources",
    `[resource-arguments] [${ctx.connectorId}:${ctx.workspaceId}] ${line}`,
  );
}

/** Bytes the contents carry: UTF-8 text, and decoded base64 blobs. */
function contentsSize(contents: ReadResourceResult["contents"]): number {
  let total = 0;
  for (const c of contents) {
    if ("text" in c && typeof c.text === "string") total += Buffer.byteLength(c.text, "utf8");
    else if ("blob" in c && typeof c.blob === "string") total += base64DecodedLength(c.blob);
  }
  return total;
}

function base64DecodedLength(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/** A URI's scheme, lowercased, or null when it has none. */
function schemeOf(uri: string): string | null {
  const colon = uri.indexOf(":");
  if (colon <= 0) return null;
  const scheme = uri.slice(0, colon).toLowerCase();
  return SCHEME_RE.test(scheme) ? scheme : null;
}

/** Whether `uri` is one of `template`'s expansions. A template that does not parse matches nothing. */
function expandsFrom(template: string, uri: string): boolean {
  try {
    return new UriTemplate(template).match(uri) !== null;
  } catch {
    return false;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
