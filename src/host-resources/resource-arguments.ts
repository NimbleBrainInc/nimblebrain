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

/**
 * The span event recording one URI's resolution on the tool call's span: the
 * URI, the serving connector, the outcome code, and the bytes handed on.
 */
export const RESOURCE_ARGUMENT_SPAN_EVENT = "resource_argument";

/** Most distinct URIs resolved for one call. Each costs a read and a rate-limit token. */
export const RESOURCE_ARGUMENTS_MAX_URIS = 32;

/** The limits a resolver applies, which the capability advertises. */
export interface ResourceArgumentsLimits {
  /** Most characters of text one resource may carry; the agent's own read limit. */
  maxChars: number;
  /** Most bytes of resolved text one call carries, all URIs together. */
  maxSize: number;
  /** Most distinct URIs resolved for one call. */
  maxUris: number;
}

/** The capability a workspace connector's connection claims: the limits a tool can plan around. */
export function resourceArgumentsClientExtension(
  limits: ResourceArgumentsLimits,
): Record<string, { maxChars: number; maxSize: number; maxUris: number }> {
  return {
    [RESOURCE_ARGUMENTS_EXTENSION_ID]: {
      maxChars: limits.maxChars,
      maxSize: limits.maxSize,
      maxUris: limits.maxUris,
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
  | "not_text"
  | "too_large"
  | "too_many"
  | "rate_limited";

/** One URI's text contents, as the serving server's `resources/read` returned them. */
export type ResourceArgumentTextContents = { uri: string; mimeType?: string; text: string }[];

/** One URI's entry in the call's `_meta`: the read result, or why there is none. */
export type ResourceArgumentEntry =
  | { contents: ResourceArgumentTextContents }
  | { error: { code: ResourceArgumentErrorCode; message: string } };

/** URI → entry, as it rides in the call's `_meta[RESOURCE_ARGUMENTS_EXTENSION_ID]`. */
export type ResourceArgumentEntries = Record<string, ResourceArgumentEntry>;

/**
 * What the host did for one URI, for the audit trail: never the contents. One
 * per entry, in argument order. `source` is set when a serving connector was
 * found; `bytes` is the UTF-8 size of the contents handed on (0 when none).
 */
export interface ResourceArgumentResolution {
  uri: string;
  source?: string;
  outcome: "resolved" | ResourceArgumentErrorCode;
  bytes: number;
}

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
  signal?: AbortSignal;
}

/** Resolves a call's declared URIs. One per runtime, shared by every workspace connector. */
export interface ResourceArgumentsResolver {
  readonly limits: ResourceArgumentsLimits;
  resolve(
    uris: readonly { uri: string; declared: boolean }[],
    ctx: ResourceArgumentsContext,
  ): Promise<{ entries: ResourceArgumentEntries; resolutions: ResourceArgumentResolution[] }>;
}

export interface ResourceArgumentsResolverDeps {
  /**
   * The connectors the call may read from: those of the calling connection's
   * own workspace, narrowed to what the caller could read itself (an unattended
   * run whose tool limit excludes resource reads gets none). Resolution looks
   * nowhere else, so a connector in another workspace can never answer.
   */
  sourcesOf(workspaceId: string): readonly ResourceServingSource[];
  /** Whether the host resolves this URI's scheme itself (`files://`, `ui://`, …), so no connector may claim it. */
  isHostScheme(uri: string): boolean;
  /** The per-(workspace, connector) budget the host-resources methods spend from. */
  rateLimit: HostResourcesRateLimit;
  /** Most characters of text per resource: the limit the agent's own read applies. */
  maxChars: number;
  /** Most bytes of resolved text per call. */
  maxSize?: number;
  maxUris?: number;
}

const NOT_FOUND_MESSAGE = "No connector in this workspace returned this resource.";

/**
 * Worst-case UTF-8 bytes of a string of `chars` UTF-16 code units: three per
 * unit (a surrogate pair is two units and four bytes).
 */
const MAX_UTF8_BYTES_PER_CHAR = 3;

/**
 * The resolver: for each declared URI, find the one connector the call may read
 * from whose resource templates the URI expands from, and read it there.
 *
 * Ownership is by template, never by asking every source until one answers
 * (the `ai.nimblebrain/open` rule): a connector cannot answer for a scheme it
 * does not advertise, and two claimants is a workspace defect reported as
 * `ambiguous` rather than guessed. The read runs in the request context of the
 * tool call, so the serving connector sees what it sees for the agent's own
 * read in this workspace.
 *
 * What is handed on is narrowed to what the agent's own read would give it:
 * text only (a blob is `not_text`, never bytes), and no more characters than
 * `maxChars`, the agent's read limit (`too_large`, never cut).
 *
 * "No connector serves it", "the read failed", and "the read returned nothing"
 * all collapse to `not_found`, as `ai.nimblebrain/resources/read` collapses
 * them: the calling connector learns nothing about what exists beyond the
 * contents it is handed. The real cause goes to the log.
 */
export function createResourceArgumentsResolver(
  deps: ResourceArgumentsResolverDeps,
): ResourceArgumentsResolver {
  const limits: ResourceArgumentsLimits = {
    maxChars: deps.maxChars,
    maxSize: deps.maxSize ?? HOST_RESOURCES_MAX_READ_SIZE,
    maxUris: deps.maxUris ?? RESOURCE_ARGUMENTS_MAX_URIS,
  };
  const reservation = limits.maxChars * MAX_UTF8_BYTES_PER_CHAR;

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
  ): Promise<Outcome> {
    const owners = await ownersOf(uri, sources);
    if (owners.length > 1) {
      return outcome(
        uri,
        "ambiguous",
        `More than one connector in this workspace serves this URI: ${owners.map((o) => o.name).join(", ")}.`,
      );
    }
    const owner = owners[0];
    if (!owner) {
      debug(ctx, `${uri} → no serving connector the call may read`);
      return outcome(uri, "not_found", NOT_FOUND_MESSAGE);
    }
    // A token is spent only on a read that is made.
    try {
      deps.rateLimit.check(ctx.workspaceId, ctx.connectorId);
    } catch {
      return outcome(
        uri,
        "rate_limited",
        "Rate limited: this connector's resource budget is spent.",
        owner.name,
      );
    }
    const contents = await owner
      .readResourceContents(uri, ctx.signal ? { signal: ctx.signal } : undefined)
      .catch(() => null);
    if (!contents || contents.length === 0) {
      log.warn(
        `[resource-arguments] [${ctx.connectorId}:${ctx.workspaceId}] read ${uri} from ${owner.name} returned nothing (collapsing to not_found)`,
      );
      return outcome(uri, "not_found", NOT_FOUND_MESSAGE, owner.name);
    }
    const text = textOnly(contents);
    if (!text) {
      return outcome(
        uri,
        "not_text",
        "The resource is not text; the host hands on text only.",
        owner.name,
      );
    }
    const chars = text.reduce((n, c) => n + c.text.length, 0);
    if (chars > limits.maxChars) {
      return outcome(
        uri,
        "too_large",
        `A resolved resource is capped at ${limits.maxChars} characters; this one is ${chars}.`,
        owner.name,
      );
    }
    const bytes = text.reduce((n, c) => n + Buffer.byteLength(c.text, "utf8"), 0);
    debug(ctx, `${uri} → ${owner.name} (${bytes}B)`);
    return {
      entry: { contents: text },
      resolution: { uri, source: owner.name, outcome: "resolved", bytes },
    };
  }

  /**
   * Admission, in argument order and before anything is read: each read
   * reserves the most bytes a resource within `maxChars` can carry, so a read
   * that is made is never dropped afterwards for the call's cap, and no
   * response is held waiting for the others to settle.
   */
  function admit(uris: readonly { uri: string; declared: boolean }[]) {
    const admitted: string[] = [];
    const refused = new Map<string, Outcome>();
    let reserved = 0;
    for (const { uri, declared } of uris) {
      if (!declared) {
        refused.set(
          uri,
          outcome(
            uri,
            "scheme_not_declared",
            "This argument does not declare the URI's scheme, so the host did not read it.",
          ),
        );
      } else if (admitted.length >= limits.maxUris) {
        refused.set(
          uri,
          outcome(uri, "too_many", `A call resolves at most ${limits.maxUris} URIs.`),
        );
      } else if (reserved + reservation > limits.maxSize) {
        refused.set(
          uri,
          outcome(
            uri,
            "too_large",
            `The resolved contents of one call are capped at ${limits.maxSize} bytes.`,
          ),
        );
      } else {
        admitted.push(uri);
        reserved += reservation;
      }
    }
    return { admitted, refused };
  }

  return {
    limits,
    async resolve(uris, ctx) {
      const { admitted, refused } = admit(uris);
      const sources = admitted.length > 0 ? deps.sourcesOf(ctx.workspaceId) : [];
      const read = await Promise.all(admitted.map((uri) => readOne(uri, ctx, sources)));
      const byUri = new Map(admitted.map((uri, i) => [uri, read[i]]));

      const entries: ResourceArgumentEntries = {};
      const resolutions: ResourceArgumentResolution[] = [];
      for (const { uri } of uris) {
        const r = refused.get(uri) ?? byUri.get(uri);
        if (!r) continue;
        entries[uri] = r.entry;
        resolutions.push(r.resolution);
      }
      return { entries, resolutions };
    },
  };
}

/** One URI's entry and its audit record. */
type Outcome = { entry: ResourceArgumentEntry; resolution: ResourceArgumentResolution };

function outcome(
  uri: string,
  code: ResourceArgumentErrorCode,
  message: string,
  source?: string,
): Outcome {
  return {
    entry: { error: { code, message } },
    resolution: { uri, ...(source ? { source } : {}), outcome: code, bytes: 0 },
  };
}

/** The contents when every entry is text, else null: one blob makes the resource not text. */
function textOnly(contents: ReadResourceResult["contents"]): ResourceArgumentTextContents | null {
  const text: ResourceArgumentTextContents = [];
  for (const c of contents) {
    if (!("text" in c) || typeof c.text !== "string") return null;
    text.push({ uri: c.uri, ...(c.mimeType ? { mimeType: c.mimeType } : {}), text: c.text });
  }
  return text;
}

function debug(ctx: ResourceArgumentsContext, line: string): void {
  log.debug(
    "host-resources",
    `[resource-arguments] [${ctx.connectorId}:${ctx.workspaceId}] ${line}`,
  );
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
