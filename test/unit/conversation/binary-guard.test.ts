/**
 * Defensive guard against issue #54: binary payloads (Buffer / Uint8Array)
 * must not be persisted into conversation JSONL files, where they
 * serialise as `{"0":N,"1":N,...}` and bloat the file ~10×.
 *
 * Two layers tested here:
 *   1. The `assertNoBinaryPayloads` helper itself — sanity tests for the
 *      detection logic across the typed-array family and nested shapes.
 *   2. The store wiring — `append()` on both event-sourced and JSONL
 *      stores must reject binary-bearing messages, and a clean message
 *      with a `resource_link` must round-trip without producing the
 *      per-byte dict pattern on disk.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoBinaryPayloads } from "../../../src/conversation/binary-guard.ts";
import { EventSourcedConversationStore } from "../../../src/conversation/event-sourced-store.ts";
import { JsonlConversationStore } from "../../../src/conversation/jsonl-store.ts";
import type { StoredMessage } from "../../../src/conversation/types.ts";

function makeDir(): string {
  const base = mkdtempSync(join(tmpdir(), "binary-guard-"));
  const dir = join(base, "conversations");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Per-byte dict shape that bloats JSONL — see issue #54. */
const PER_BYTE_DICT_RE = /"\d+":\d+,"\d+":\d+/;

describe("assertNoBinaryPayloads", () => {
  it("accepts plain JSON-shaped objects", () => {
    expect(() =>
      assertNoBinaryPayloads(
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "resource_link", uri: "files://fl_x", mimeType: "image/png", name: "p.png" },
          ],
          timestamp: "2026-05-18T00:00:00.000Z",
        },
        "msg",
      ),
    ).not.toThrow();
  });

  it("throws on Buffer at the top level", () => {
    expect(() => assertNoBinaryPayloads(Buffer.from([1, 2, 3]), "top")).toThrow(
      /Refusing to persist binary payload at top/,
    );
  });

  it("throws on Uint8Array nested inside contentParts", () => {
    expect(() =>
      assertNoBinaryPayloads(
        {
          role: "user",
          content: [{ type: "image", image: new Uint8Array([137, 80, 78, 71]) }],
        },
        "message",
      ),
    ).toThrow(/message\.content\[0\]\.image/);
  });

  it("throws on a raw ArrayBuffer", () => {
    expect(() => assertNoBinaryPayloads({ data: new ArrayBuffer(4) }, "msg")).toThrow(
      /ArrayBuffer at msg\.data/,
    );
  });

  it("detects typed-array subclasses other than Uint8Array", () => {
    expect(() =>
      assertNoBinaryPayloads({ samples: new Int16Array([1, 2, 3]) }, "audio"),
    ).toThrow(/audio\.samples \(Int16Array\)/);
  });

  it("does not loop forever on a cyclic object", () => {
    const obj: Record<string, unknown> = { role: "user" };
    obj.self = obj;
    expect(() => assertNoBinaryPayloads(obj, "cyclic")).not.toThrow();
  });
});

describe("conversation stores reject binary-bearing messages (issue #54)", () => {
  it("EventSourcedConversationStore.append throws on Buffer in contentParts", async () => {
    const store = new EventSourcedConversationStore({ dir: makeDir() });
    const conv = await store.create();

    const poisoned = {
      role: "user",
      timestamp: "2026-05-18T00:00:00.000Z",
      content: [
        { type: "text", text: "what's this?" },
        // The historical bug shape: bytes inline in the content part.
        { type: "image", image: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ],
    } as unknown as StoredMessage;

    await expect(store.append(conv, poisoned)).rejects.toThrow(/Refusing to persist binary/);
  });

  it("JsonlConversationStore.append throws on Uint8Array in contentParts", async () => {
    const store = new JsonlConversationStore(makeDir());
    const conv = await store.create();

    const poisoned = {
      role: "user",
      timestamp: "2026-05-18T00:00:00.000Z",
      content: [{ type: "image", image: new Uint8Array([1, 2, 3, 4]) }],
    } as unknown as StoredMessage;

    await expect(store.append(conv, poisoned)).rejects.toThrow(/Refusing to persist binary/);
  });

  it("clean message with resource_link round-trips without per-byte dict pattern", async () => {
    const dir = makeDir();
    const store = new EventSourcedConversationStore({ dir });
    const conv = await store.create();

    const clean: StoredMessage = {
      role: "user",
      timestamp: "2026-05-18T00:00:00.000Z",
      content: [
        { type: "text", text: "see this image" },
        { type: "resource_link", uri: "files://fl_test", mimeType: "image/png", name: "p.png" },
      ],
    };
    await store.append(conv, clean);

    const raw = readFileSync(join(dir, `${conv.id}.jsonl`), "utf-8");
    expect(raw).toContain("files://fl_test");
    expect(raw).not.toMatch(PER_BYTE_DICT_RE);
  });
});
