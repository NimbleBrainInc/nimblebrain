// ---------------------------------------------------------------------------
// open_app — put what a URI names, or an app, on the user's screen.
//
// One resolver for every way the screen is moved (ADR-0052): an app's view
// asking with `ai.nimblebrain/open`, which the shell forwards here as `{ uri }`,
// and the agent's own call. The tool decides where the URI opens and answers
// that destination; the web client applies it. A conversation opens in the chat
// panel; anything else opens the app that shows it, which the shell hands the
// URI as `ai.nimblebrain/navigate` once the app is on screen.
//
// Resolution is by ownership, never by trying reads:
//   1. `conversation://<id>`: a kernel surface, the chat panel.
//   2. An app's own `ui://` resource: that app, at its home.
//   3. Anything else: the one openable app whose server advertises a resource
//      template the URI expands from, at the view that template names
//      (`_meta["ai.nimblebrain/view"]`, ADR-0059), else at the app's first view.
//      Two claimants is a workspace defect, and refused rather than guessed.
//
// For the agent's call only the web client that sent the turn acts, and only
// on its own live turn: a conversation reloaded from history, reattached after
// a reload, or watched from another tab never moves anyone's screen.
// ---------------------------------------------------------------------------

import { UriTemplate } from "@modelcontextprotocol/server";
import type { PlacementEntry } from "../connectors/runtime/types.ts";
import { uriToConversationId } from "../conversation/uri.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { Runtime } from "../runtime/runtime.ts";
import { isIdentitySource } from "./identity-sources.ts";
import type { InProcessTool } from "./in-process-app.ts";
import { McpSource } from "./mcp-source.ts";

export const OPEN_APP_TOOL = "open_app";

/**
 * Where an open lands, as the tool answers it in `structuredContent`: the chat
 * panel at a conversation, or an app (by route, else server name) at an
 * optional target.
 */
export type OpenDestination =
  | { conversationId: string }
  | { app: string; name: string; target?: string };

type Resolution = { destination: OpenDestination } | { error: string };

/** What resolution reads, so it can be exercised without a runtime. */
export interface OpenScope {
  placements: readonly PlacementEntry[];
  /**
   * The resource templates a server advertises, each with the `ui://` URI of the view that
   * shows its records when the server names one; empty when it advertises none.
   */
  templatesOf(serverName: string): Promise<readonly { uriTemplate: string; view?: string }[]>;
  /** Whether a conversation is one of the caller's in this workspace. */
  hasConversation(id: string): boolean;
}

/** A placement the user can open: it has a route and sits in the shell's nav. */
function isOpenable(p: PlacementEntry): boolean {
  return Boolean(p.route) && (p.slot === "main" || p.slot.startsWith("sidebar"));
}

function displayName(p: PlacementEntry): string {
  return p.label ?? p.route ?? p.serverName;
}

function appDestination(p: PlacementEntry, target?: string): OpenDestination {
  return {
    app: p.route ?? p.serverName,
    name: displayName(p),
    ...(target !== undefined ? { target } : {}),
  };
}

/**
 * The placement `app` names in a workspace's placements: an exact route first,
 * then a server name, then a case-insensitive label. The shell resolves the
 * same route and server-name forms, so whatever this accepts, it can open.
 */
export function findOpenableApp(
  placements: readonly PlacementEntry[],
  app: string,
): PlacementEntry | undefined {
  const openable = placements.filter(isOpenable);
  const wanted = app.trim().toLowerCase();
  return (
    openable.find((p) => p.route === app) ??
    openable.find((p) => p.serverName === app) ??
    openable.find((p) => p.label?.toLowerCase() === wanted)
  );
}

/** Each openable app's display name, for an error that lets the model retry. */
export function openableAppNames(placements: readonly PlacementEntry[]): string[] {
  return [...new Set(placements.filter(isOpenable).map(displayName))];
}

interface TemplateExpression {
  /** The characters this expression's compiled class cannot consume. */
  stops: string;
  /** The literal the compiled pattern puts before the expression's value. */
  prefix: string;
  start: number;
  end: number;
}

/** One expression as the SDK's `UriTemplate` compiles it to a regex. */
function templateExpression(body: string, start: number, end: number): TemplateExpression {
  const operator = "+#./;?&".includes(body[0] ?? "") ? (body[0] ?? "") : "";
  const exploded = body.includes("*");
  const first = body.slice(operator.length).split(",")[0]?.replace("*", "").trim() ?? "";
  switch (operator) {
    case "+":
    case "#":
      return { stops: "", prefix: "", start, end };
    case "?":
    case "&":
      return { stops: "&", prefix: `${operator}${first}=`, start, end };
    case ";":
      return { stops: "/", prefix: "", start, end };
    case ".":
      return { stops: "/,", prefix: ".", start, end };
    case "/":
      return { stops: exploded ? "/" : "/,", prefix: "/", start, end };
    default:
      return { stops: exploded ? "/" : "/,", prefix: "", start, end };
  }
}

/**
 * Whether a template's match can cost more than quadratic time. An expression's value ends at a
 * single place when the text after it (the literal, then the next expression's prefix) holds a
 * character the value cannot consume; the SDK compiles `{x}` to `([^/,]+)`, `{;x}` to `([^/]+)`,
 * `{?x}` to `\?x=([^&]+)` and `{+x}` / `{#x}` to `(.+)`. Each boundary where the value could end
 * in more than one place multiplies the work on a URI that does not match by its length, so a
 * template with more than one such boundary matches nothing. One is allowed, so `{id}{?cursor}`
 * and `{+path}` still match. The last expression ends where the URI does. Templates come from
 * connectors, so matching one must stay cheap.
 */
function isUnboundedTemplate(template: string): boolean {
  // One pass over the braces: a regex scan retries from every `{` that never closes.
  const expressions: TemplateExpression[] = [];
  for (let open = template.indexOf("{"); open !== -1; ) {
    const close = template.indexOf("}", open);
    if (close === -1) return true; // Unclosed: the SDK rejects it too.
    expressions.push(templateExpression(template.slice(open + 1, close), open, close + 1));
    open = template.indexOf("{", close);
  }
  let ambiguous = 0;
  for (let i = 0; i + 1 < expressions.length; i++) {
    const current = expressions[i];
    const next = expressions[i + 1];
    if (!current || !next) continue;
    const between = template.slice(current.end, next.start) + next.prefix;
    if (![...between].some((c) => current.stops.includes(c)) && ++ambiguous > 1) return true;
  }
  return false;
}

/** Most templates a process keeps parsed; past it the oldest is dropped. */
const TEMPLATE_CACHE_LIMIT = 512;

/** Each template string seen, parsed once; `null` for one that is refused or does not parse. */
const templateCache = new Map<string, UriTemplate | null>();

function compiled(template: string): UriTemplate | null {
  const cached = templateCache.get(template);
  if (cached !== undefined) return cached;
  let parsed: UriTemplate | null = null;
  if (!isUnboundedTemplate(template)) {
    try {
      parsed = new UriTemplate(template);
    } catch {
      parsed = null;
    }
  }
  if (templateCache.size >= TEMPLATE_CACHE_LIMIT) {
    const oldest = templateCache.keys().next().value;
    if (oldest !== undefined) templateCache.delete(oldest);
  }
  templateCache.set(template, parsed);
  return parsed;
}

/**
 * Whether `uri` is one of `template`'s expansions. A template that does not parse, or whose
 * match could backtrack without bound (`isUnboundedTemplate`), matches nothing.
 */
function expandsFrom(template: string, uri: string): boolean {
  const parsed = compiled(template);
  if (parsed === null) return false;
  try {
    return parsed.match(uri) !== null;
  } catch {
    return false;
  }
}

/** Where `uri` opens in `scope`, or why it opens nowhere. */
export async function resolveOpen(scope: OpenScope, uri: string): Promise<Resolution> {
  const conversationId = uriToConversationId(uri);
  if (conversationId !== null) {
    return scope.hasConversation(conversationId)
      ? { destination: { conversationId } }
      : { error: `No conversation ${uri} in this workspace.` };
  }

  // Each server's openable views, highest priority first. The first is where a record opens
  // when its template names no view.
  const apps = new Map<string, PlacementEntry[]>();
  for (const p of scope.placements.filter(isOpenable)) {
    apps.set(p.serverName, [...(apps.get(p.serverName) ?? []), p]);
  }

  const home = scope.placements.find((p) => isOpenable(p) && p.resourceUri === uri);
  if (home) return { destination: appDestination(home) };

  // A template names a view only among its own server's views, so a server can choose where
  // its records open in its own app and never send one into another app.
  const claims = await Promise.all(
    [...apps.values()].map(async (views) => {
      const [first] = views;
      if (!first) return null;
      const templates = await scope.templatesOf(first.serverName);
      const match = templates.find((t) => expandsFrom(t.uriTemplate, uri));
      if (!match) return null;
      return views.find((p) => match.view !== undefined && p.resourceUri === match.view) ?? first;
    }),
  );
  const owners = claims.filter((p): p is PlacementEntry => p !== null);
  if (owners.length === 1 && owners[0]) return { destination: appDestination(owners[0], uri) };
  if (owners.length > 1) {
    return { error: `More than one app claims ${uri}: ${owners.map(displayName).join(", ")}.` };
  }
  return { error: `Nothing in this workspace opens ${uri}.` };
}

/** The live scope for the caller's workspace: its placements, its servers' templates, its conversations. */
function scopeFor(runtime: Runtime, wsId: string): OpenScope {
  const registry = runtime.getRegistryForWorkspace(wsId);
  return {
    placements: runtime.getPlacementRegistry().forWorkspace(wsId),
    async templatesOf(serverName) {
      // A kernel identity app sits in no workspace registry.
      const source = isIdentitySource(serverName)
        ? runtime.getIdentitySource(serverName)
        : registry.getSource(serverName);
      return source instanceof McpSource ? source.resourceTemplates() : [];
    },
    hasConversation(id) {
      const ownerId = runtime.getCurrentIdentity()?.id;
      if (!ownerId) return false;
      try {
        runtime.assertConversationInWorkspace(id, wsId, ownerId);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function refusal(text: string): ToolResult {
  return { content: textContent(text), isError: true };
}

function answer(destination: OpenDestination): ToolResult {
  let text: string;
  if ("conversationId" in destination) {
    text = `Opening the conversation in the chat panel.`;
  } else if (destination.target) {
    // The app, not this server, decides whether it can go to the target, and
    // nothing reports back whether it did, so the answer claims only what is
    // known: the app is opening, and it was handed the address.
    const { name, target } = destination;
    text = `Opening ${name} at ${target}. ${name} goes there if it supports opening at that address; otherwise it shows its home screen, or stays on what it was showing if it was already open.`;
  } else {
    text = `Opening ${destination.name}.`;
  }
  return { content: textContent(text), structuredContent: destination, isError: false };
}

/** The tool's answer for an app named by the model: that app at its home. */
function openAppByName(placements: readonly PlacementEntry[], app: string): ToolResult {
  const found = findOpenableApp(placements, app);
  if (found) return answer(appDestination(found));
  const names = openableAppNames(placements);
  return refusal(
    names.length > 0
      ? `No app named "${app}" in this workspace. Apps: ${names.join(", ")}.`
      : `No app named "${app}": this workspace has no apps to open.`,
  );
}

export function createOpenAppTool(runtime: Runtime): InProcessTool {
  return {
    name: OPEN_APP_TOOL,
    description:
      "Open something on the user's screen. Pass `uri` to open what a resource URI names: a record (find it first with the app's own tools; its records often carry a `uri`), a file (`files://<id>`), or a conversation (`conversation://<id>`). The platform finds the app that shows it. Pass `app` instead to open an app at its home (\"open People\"). An app goes to the record only if it supports that address, so tell the user it is opening, not that the record is on screen. Opens only on the screen of the user who asked, in the conversation they are watching.",
    inputSchema: {
      type: "object",
      properties: {
        uri: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description: "What to open, by its resource URI. Give this or `app`, not both.",
        },
        app: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "An app to open at its home, by its name as the sidebar shows it (e.g. 'People') or its id. Give this or `uri`, not both.",
        },
      },
      additionalProperties: false,
    },
    handler: async (input): Promise<ToolResult> => {
      const uri = typeof input.uri === "string" ? input.uri : undefined;
      const app = typeof input.app === "string" ? input.app : undefined;
      if ((uri === undefined) === (app === undefined)) {
        return refusal("Give exactly one of `uri` or `app`.");
      }
      const wsId = runtime.requireWorkspaceId();
      if (uri !== undefined) {
        const resolved = await resolveOpen(scopeFor(runtime, wsId), uri);
        return "error" in resolved ? refusal(resolved.error) : answer(resolved.destination);
      }
      return openAppByName(runtime.getPlacementRegistry().forWorkspace(wsId), app ?? "");
    },
  };
}
