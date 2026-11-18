/**
 * Reading a server's MCP Server Card (SEP-2127, extension
 * `io.modelcontextprotocol/server-card`) for a connector added by URL on a
 * local install (ADR-0065).
 *
 * The card is untrusted and advisory. It names the server and describes it for
 * display; nothing in it decides access. Of its `_meta["ai.nimblebrain/host"]`
 * block only `placements` is read: `hooks`, `notifications`, `admin_tools` and
 * `record_arguments` are operator grants, read from a catalog entry only.
 * A card that is missing, slow, too large or malformed reads as no card.
 */

import type { FetchLike } from "@modelcontextprotocol/client";
import { NIMBLEBRAIN_HOST_META_KEY } from "../catalog/server-detail.ts";
import { sanitizePlacements } from "./defaults.ts";
import { isLoopbackHostname } from "./host-loopback.ts";
import type { ConnectorUiMeta, PlacementDeclaration } from "./types.ts";

/** The card's media type, sent as `Accept`. */
export const SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json";

/** How long the card request may take before the install goes on without it. */
export const SERVER_CARD_TIMEOUT_MS = 5_000;

/** The most bytes of card body read; a larger card reads as none. */
export const SERVER_CARD_MAX_BYTES = 256 * 1024;

/** Display strings from the card are capped at this many code points. */
const NAME_MAX = 128;
const DESCRIPTION_MAX = 1_000;
/** An icon URL longer than this (a large inline `data:` image) is dropped. */
const ICON_URL_MAX = 64 * 1024;

/** What the runtime takes from a server's card. Every field is optional. */
export interface ServerCardInfo {
  /** The card's `name` (the server's canonical name), sanitized. */
  name?: string;
  title?: string;
  description?: string;
  /** The first icon whose `src` is `https:`, `data:image/…`, or loopback `http:`. */
  iconUrl?: string;
  /** Placements from `_meta["ai.nimblebrain/host"]`, when at least one is valid. */
  ui?: ConnectorUiMeta;
}

/** `<url>/server-card`: the card's path, under the server's MCP path. */
export function serverCardUrl(serverUrl: URL): URL {
  const card = new URL(serverUrl.toString());
  card.pathname = `${card.pathname.replace(/\/+$/, "")}/server-card`;
  card.search = "";
  card.hash = "";
  return card;
}

/**
 * Fetch and parse the card served under `serverUrl`, or null. Never throws:
 * a card is advisory, and an install proceeds without one.
 */
export async function fetchServerCard(
  serverUrl: URL,
  fetchImpl: FetchLike,
  opts: { timeoutMs?: number } = {},
): Promise<ServerCardInfo | null> {
  try {
    const res = await fetchImpl(serverCardUrl(serverUrl), {
      method: "GET",
      headers: { Accept: SERVER_CARD_MEDIA_TYPE },
      signal: AbortSignal.timeout(opts.timeoutMs ?? SERVER_CARD_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const body = await readCapped(res, SERVER_CARD_MAX_BYTES);
    if (body === null) return null;
    return parseServerCard(JSON.parse(body));
  } catch {
    return null;
  }
}

/** The body as text, or null when it exceeds `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** What the runtime takes from a parsed card body, or null when it is not an object. */
export function parseServerCard(raw: unknown): ServerCardInfo | null {
  if (!isRecord(raw)) return null;
  const out: ServerCardInfo = {};
  const name = displayString(raw.name, NAME_MAX);
  if (name) out.name = name;
  const title = displayString(raw.title, NAME_MAX);
  if (title) out.title = title;
  const description = displayString(raw.description, DESCRIPTION_MAX);
  if (description) out.description = description;
  const iconUrl = firstIconUrl(raw.icons);
  if (iconUrl) out.iconUrl = iconUrl;
  const ui = cardPlacements(raw._meta);
  if (ui) out.ui = ui;
  return out;
}

/**
 * Only `placements` from the card's host block, sanitized (the card is
 * untrusted and the stored row outlives this read). Every other key in the
 * block is an operator grant and is never read here.
 */
function cardPlacements(meta: unknown): ConnectorUiMeta | null {
  if (!isRecord(meta)) return null;
  const host = meta[NIMBLEBRAIN_HOST_META_KEY];
  if (!isRecord(host) || !Array.isArray(host.placements)) return null;
  // `sanitizePlacements` type-checks every field of every element before
  // reading it, so the unchecked array is safe to hand it.
  const placements = sanitizePlacements(host.placements as PlacementDeclaration[]);
  return placements.length > 0 ? { placements } : null;
}

function firstIconUrl(icons: unknown): string | undefined {
  if (!Array.isArray(icons)) return undefined;
  for (const icon of icons) {
    if (isRecord(icon) && typeof icon.src === "string" && isAcceptedIconUrl(icon.src)) {
      return icon.src;
    }
  }
  return undefined;
}

/**
 * A card icon is shown by the browser, so only a source that cannot reach
 * anything the developer did not point at: `https:`, an inline `data:image/…`,
 * or plain `http:` on a loopback name (the developer's own server).
 */
export function isAcceptedIconUrl(src: string): boolean {
  if (src.length > ICON_URL_MAX) return false;
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(src)) return true;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHostname(url.hostname);
}

/** A printable, trimmed string capped at `max` code points, or undefined. */
function displayString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const printable = Array.from(value)
    .filter((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp > 0x1f && !(cp >= 0x7f && cp <= 0x9f);
    })
    .join("")
    .trim();
  const capped = Array.from(printable).slice(0, max).join("").trim();
  return capped || undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
