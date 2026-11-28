/**
 * How a scenario reaches a runtime: REST, the conversation event stream, and
 * the MCP door, each as one signed-in person, against the target's base URL.
 * Nothing here imports the runtime; every target is reached over the wire.
 */

import { type Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type {
  BootstrapResponse,
  ChatResponse,
  ToolCallResponse,
} from "../../src/api/schemas/responses.ts";
import { newMcpClient } from "../helpers/mcp-client.ts";

/** A signed-in caller: the bearer token the target accepts for them. */
export interface Caller {
  name: string;
  token: string;
}

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  /** The body parsed as JSON, or undefined when it is not JSON. */
  json: unknown;
  bytes: Uint8Array;
}

export interface SseEvent {
  type: string;
  data: unknown;
  /** The frame's `id:`, the event's sequence number, when it carries one. */
  seq?: number;
}

/** A finished turn as the event stream told it. */
export interface Turn {
  conversationId: string;
  startStatus: number;
  events: SseEvent[];
  /** The `done` frame's body, when the turn finished. */
  done?: ChatResponse;
  /** How the stream ended: `done`, `cancelled`, `error`, or `timeout`. */
  end: string;
}

export class E2EClient {
  constructor(readonly baseUrl: string) {}

  async rest(
    caller: Caller | null,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    const init: RequestInit = {
      method,
      headers: {
        ...(caller ? { Authorization: `Bearer ${caller.token}` } : {}),
        ...(body !== undefined && !(body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...headers,
      },
    };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${this.baseUrl}${path}`, init);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, text, json, bytes };
  }

  async bootstrap(caller: Caller): Promise<BootstrapResponse> {
    const r = await this.rest(caller, "GET", "/v1/bootstrap");
    if (r.status !== 200)
      throw new Error(`bootstrap answered ${r.status}: ${r.text.slice(0, 300)}`);
    return r.json as BootstrapResponse;
  }

  /** `POST /v1/workspaces/:ws/tools/call`. */
  async tool(
    caller: Caller,
    ws: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolCallResponse & { status: number }> {
    const r = await this.rest(
      caller,
      "POST",
      `/v1/workspaces/${ws}/tools/call`,
      envelope(name, args),
    );
    return toolReply(r);
  }

  /** `POST /v1/tools/call`: a tool that needs no workspace. */
  async identityTool(
    caller: Caller,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolCallResponse & { status: number }> {
    const r = await this.rest(caller, "POST", "/v1/tools/call", envelope(name, args));
    return toolReply(r);
  }

  /** `POST /v1/workspaces/:ws/chat/start`, JSON or multipart. */
  startChat(caller: Caller, ws: string, body: Record<string, unknown> | FormData): Promise<Reply> {
    return this.rest(caller, "POST", `/v1/workspaces/${ws}/chat/start`, body);
  }

  /**
   * Read a conversation's event stream until the turn ends (`done`,
   * `cancelled` or `error`) or `timeoutMs` passes. `onEvent` sees each frame
   * as it arrives, for a scenario that acts mid-turn.
   */
  async readEvents(
    caller: Caller,
    ws: string,
    conversationId: string,
    opts: { afterSeq?: number; timeoutMs?: number; onEvent?: (e: SseEvent) => void } = {},
  ): Promise<{ status: number; events: SseEvent[]; end: string }> {
    const q = opts.afterSeq !== undefined ? `?afterSeq=${opts.afterSeq}` : "";
    const controller = new AbortController();
    const res = await fetch(
      `${this.baseUrl}/v1/workspaces/${ws}/conversations/${conversationId}/events${q}`,
      { headers: { Authorization: `Bearer ${caller.token}` }, signal: controller.signal },
    );
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, events: [], end: "refused" };
    }
    const events: SseEvent[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let end = "timeout";
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
    try {
      outer: for (;;) {
        const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (chunk.done || !chunk.value) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          sep = buffer.indexOf("\n\n");
          const event = parseFrame(frame);
          if (!event) continue;
          events.push(event);
          opts.onEvent?.(event);
          if (event.type === "done" || event.type === "cancelled" || event.type === "error") {
            end = event.type;
            break outer;
          }
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    return { status: 200, events, end };
  }

  /** Start a turn and follow it to its end. */
  async turn(
    caller: Caller,
    ws: string,
    body: Record<string, unknown> | FormData,
    opts: { timeoutMs?: number; onEvent?: (e: SseEvent) => void } = {},
  ): Promise<Turn> {
    const start = await this.startChat(caller, ws, body);
    const conversationId = (start.json as { conversationId?: string } | undefined)?.conversationId;
    if (start.status !== 200 || !conversationId) {
      return {
        conversationId: "",
        startStatus: start.status,
        events: [],
        end: `start:${start.text.slice(0, 300)}`,
      };
    }
    const read = await this.readEvents(caller, ws, conversationId, opts);
    const done = read.events.find((e) => e.type === "done")?.data as ChatResponse | undefined;
    return {
      conversationId,
      startStatus: start.status,
      events: read.events,
      end: read.end,
      ...(done ? { done } : {}),
    };
  }

  /** An MCP client connected to `/mcp/<ws>` as `caller` (or with no credential). */
  async mcp(caller: Caller | null, ws: string): Promise<Client> {
    const client = newMcpClient({ name: "e2e-suite", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${this.baseUrl}/mcp/${ws}`), {
        requestInit: { headers: caller ? { Authorization: `Bearer ${caller.token}` } : {} },
      }),
    );
    return client;
  }
}

/** The tool-call body: `<server>__<tool>` names its source and the tool. */
function envelope(name: string, args: Record<string, unknown>) {
  const cut = name.indexOf("__");
  return { server: cut > 0 ? name.slice(0, cut) : name, tool: name, arguments: args };
}

function toolReply(r: Reply): ToolCallResponse & { status: number } {
  const body = (r.json ?? {}) as Partial<ToolCallResponse> & { error?: string; message?: string };
  return {
    status: r.status,
    content: body.content ?? [{ type: "text", text: r.text }],
    ...(body.structuredContent ? { structuredContent: body.structuredContent } : {}),
    isError: r.status !== 200 || body.isError === true,
  };
}

function parseFrame(frame: string): SseEvent | null {
  let type = "";
  let seq: number | undefined;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) type = line.slice(7).trim();
    else if (line.startsWith("id: ")) seq = Number(line.slice(4).trim());
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  if (!type) return null;
  const raw = data.join("\n");
  const at = seq !== undefined && Number.isFinite(seq) ? { seq } : {};
  try {
    return { type, data: raw ? JSON.parse(raw) : null, ...at };
  } catch {
    return { type, data: raw, ...at };
  }
}

/** The text of a tool answer's content blocks. */
export function textOf(result: { content?: Array<{ text?: string }> }): string {
  return (result.content ?? []).map((c) => c.text ?? "").join("");
}

/** A tool answer's structured content, else its text parsed as JSON. */
export function structured<T = Record<string, unknown>>(result: {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ text?: string }>;
}): T {
  if (result.structuredContent) return result.structuredContent as T;
  try {
    return JSON.parse(textOf(result)) as T;
  } catch {
    return {} as T;
  }
}
