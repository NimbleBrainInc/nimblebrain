/**
 * What `/mcp/<wsId>` changes in a connector's `input_required` answer before
 * the outside client sees it (ADR-0050), and the argument digest that binds the
 * client's `requestState` to the call it was minted for.
 *
 * The outside client attributes every request it receives to this host, so the
 * host names the connector an elicitation comes from: each `elicitation/create`
 * message, form or URL mode, is prefixed with the connector's display name. A
 * URL-mode request whose `url` is root-relative is resolved against this
 * runtime's web origin, because the client has no base to resolve it against.
 * Sampling and roots requests carry no message and pass through as they are.
 */

import { createHash } from "node:crypto";
import type { InputRequest, InputRequests } from "@modelcontextprotocol/server";

/**
 * The connector's input requests as the outside client receives them: each
 * elicitation message names `connector`, and a root-relative URL-mode `url` is
 * resolved against `origin`. A null `origin` leaves every `url` as it is.
 */
export function relayInputRequests(
  inputRequests: InputRequests,
  connector: string,
  origin: string | null,
): InputRequests {
  const out: InputRequests = {};
  for (const [key, request] of Object.entries(inputRequests)) {
    out[key] = relayInputRequest(request, connector, origin);
  }
  return out;
}

function relayInputRequest(
  request: InputRequest,
  connector: string,
  origin: string | null,
): InputRequest {
  if (request.method !== "elicitation/create") return request;
  const params = request.params;
  const message = `${connector}: ${params.message}`;
  if (params.mode === "url") {
    return {
      ...request,
      params: { ...params, message, url: resolveRelayedUrl(params.url, origin) },
    };
  }
  return { ...request, params: { ...params, message } };
}

/**
 * A URL-mode `url` as the outside client receives it. A root-relative path (one
 * leading `/`) is resolved against `origin`; anything else (an absolute URL, a
 * protocol-relative `//host`, a `/\host` a URL parser reads as one, or any
 * path when there is no origin) is left as it is, so a connector can never
 * point a relative URL at another host.
 */
export function resolveRelayedUrl(url: string, origin: string | null): string {
  if (!origin || !url.startsWith("/") || url[1] === "/" || url[1] === "\\") return url;
  try {
    const resolved = new URL(url, origin);
    return resolved.origin === new URL(origin).origin ? resolved.href : url;
  } catch {
    return url;
  }
}

/**
 * A digest of a call's arguments, independent of key order, that the sealed
 * round carries so a retry is honoured only with the arguments it was minted for.
 */
export function argsDigest(args: Record<string, unknown> | undefined): string {
  return createHash("sha256")
    .update(canonicalJson(args ?? {}))
    .digest("base64url");
}

/** JSON with object keys sorted, so equal arguments digest equal whatever their order. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
