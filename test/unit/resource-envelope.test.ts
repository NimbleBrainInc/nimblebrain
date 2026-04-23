import { describe, expect, it } from "bun:test";
import { buildResourceEnvelopeEntry } from "../../src/api/handlers.ts";

/**
 * Covers the shared helper that produces the `contents[]` entry for both
 * `handleResourceProxy` (GET /v1/apps/:name/resources/:path) and
 * `handleReadResource` (POST /v1/resources/read). The helper is the
 * handler-level seam where `_meta` from the McpSource layer reaches the
 * HTTP response, so this is the right place to assert round-trip.
 */
describe("buildResourceEnvelopeEntry", () => {
  it("emits text + mimeType + _meta for a text resource with metadata", () => {
    const entry = buildResourceEnvelopeEntry("ui://counter/show_clicker", {
      text: "<html>hi</html>",
      mimeType: "text/html",
      meta: {
        ui: {
          csp: {
            connectDomains: ["http://localhost:9991", "ws://localhost:9991"],
            frameDomains: ["http://localhost:9991"],
          },
          prefersBorder: true,
        },
      },
    });
    expect(entry.uri).toBe("ui://counter/show_clicker");
    expect(entry.text).toBe("<html>hi</html>");
    expect(entry.mimeType).toBe("text/html");
    const meta = entry._meta as { ui?: { csp?: { connectDomains?: string[] } } };
    expect(meta.ui?.csp?.connectDomains).toEqual([
      "http://localhost:9991",
      "ws://localhost:9991",
    ]);
  });

  it("base64-encodes blob for binary resources and omits text", () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    const entry = buildResourceEnvelopeEntry("ui://collateral/preview.pdf", {
      blob: bytes,
      mimeType: "application/pdf",
    });
    expect(entry.uri).toBe("ui://collateral/preview.pdf");
    expect(entry.text).toBeUndefined();
    expect(entry.mimeType).toBe("application/pdf");
    // Decode the base64 and verify round-trip
    const decoded = atob(entry.blob as string);
    expect(decoded).toBe("%PDF");
  });

  it("omits _meta and mimeType when the source didn't provide them", () => {
    const entry = buildResourceEnvelopeEntry("ui://app/foo", {
      text: "hello",
    });
    expect(entry.uri).toBe("ui://app/foo");
    expect(entry.text).toBe("hello");
    expect(entry.mimeType).toBeUndefined();
    expect(entry._meta).toBeUndefined();
  });

  it("defaults text to empty string when neither text nor blob is set", () => {
    // Guards the "falsy text" branch — better to emit text:"" than undefined
    // so clients always see exactly one of text/blob.
    const entry = buildResourceEnvelopeEntry("ui://app/empty", {});
    expect(entry.text).toBe("");
    expect(entry.blob).toBeUndefined();
  });
});
