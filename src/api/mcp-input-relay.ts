/**
 * What `/mcp/<wsId>` changes in a connector's `input_required` answer before
 * the outside client sees it (ADR-0050), and the argument digest that binds the
 * client's `requestState` to the call it was minted for.
 *
 * The outside client attributes every request it receives to this host, so the
 * host tells it which connector asked: each `elicitation/create` message, form
 * or URL mode, starts with the connector's display name, which the connector
 * neither chooses nor removes. The text after it, and a URL-mode `url`, are the
 * connector's own and pass through as they are, as do sampling and roots
 * requests, which carry no message.
 */

import { createHash } from "node:crypto";
import type { InputRequest, InputRequests } from "@modelcontextprotocol/server";

/** The connector's input requests as the outside client receives them: each elicitation message names `connector`. */
export function relayInputRequests(inputRequests: InputRequests, connector: string): InputRequests {
  const out: InputRequests = {};
  for (const [key, request] of Object.entries(inputRequests)) {
    out[key] = relayInputRequest(request, connector);
  }
  return out;
}

function relayInputRequest(request: InputRequest, connector: string): InputRequest {
  if (request.method !== "elicitation/create") return request;
  return {
    ...request,
    params: { ...request.params, message: `${connector}: ${request.params.message}` },
  };
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
