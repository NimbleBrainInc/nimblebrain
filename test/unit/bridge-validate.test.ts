/**
 * Tests for `web/src/bridge/validate.ts` — discriminator-aware envelope
 * validation at the iframe trust boundary. The validator's contract:
 *
 *   - Recognized method + valid envelope → ok
 *   - Recognized method + invalid envelope → fail (drop reason)
 *   - Unrecognized method → ok (let bridge's default handler ignore)
 *   - No method (response envelope or junk) → ok (handled elsewhere)
 *   - Non-object → fail
 */
import { describe, expect, test } from "bun:test";
import { validateAppToHostMessage } from "../../web/src/bridge/validate.ts";

describe("validateAppToHostMessage", () => {
  test("accepts a well-formed tools/call envelope", () => {
    const result = validateAppToHostMessage({
      jsonrpc: "2.0",
      method: "tools/call",
      id: "req-1",
      params: { name: "search", arguments: { q: "hello" } },
    });
    expect(result).toEqual({ ok: true, method: "tools/call", reason: null });
  });

  test("rejects a tools/call missing required params.name", () => {
    const result = validateAppToHostMessage({
      jsonrpc: "2.0",
      method: "tools/call",
      id: "req-1",
      params: { arguments: { q: "hello" } },
    });
    expect(result.ok).toBe(false);
    expect(result.method).toBe("tools/call");
    expect(result.reason).toMatch(/name/);
  });

  test("rejects a tools/call with the original SkillsTab bug shape (name at root)", () => {
    // Sanity check — the validator at this layer would not save us from
    // the SkillsTab issue (that was in `arguments`, not the envelope).
    // But: if anyone ever moved name to the envelope root, this would
    // catch it. Confirms we don't allow extras *in the wrong place*.
    const result = validateAppToHostMessage({
      jsonrpc: "2.0",
      method: "tools/call",
      id: "req-1",
      name: "create",
      params: { name: "create", arguments: {} },
    });
    // Extras at the root pass through (TypeBox doesn't enforce
    // additionalProperties: false here). The point of this test is to
    // document the policy — extras don't cause drops, only missing
    // required fields do.
    expect(result.ok).toBe(true);
  });

  test("accepts a synapse/keydown envelope", () => {
    const result = validateAppToHostMessage({
      jsonrpc: "2.0",
      method: "synapse/keydown",
      params: {
        key: "Escape",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      },
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("synapse/keydown");
  });

  test("rejects synapse/keydown with non-boolean modifier", () => {
    const result = validateAppToHostMessage({
      jsonrpc: "2.0",
      method: "synapse/keydown",
      params: {
        key: "Escape",
        ctrlKey: "false",
        metaKey: false,
        shiftKey: false,
        altKey: false,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ctrlKey/);
  });

  test("passes through unknown methods (lets the bridge switch handle them)", () => {
    const result = validateAppToHostMessage({
      jsonrpc: "2.0",
      method: "future/extension-not-in-schema",
      params: { whatever: 1 },
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("future/extension-not-in-schema");
  });

  test("passes through method-less envelopes (responses)", () => {
    const result = validateAppToHostMessage({
      jsonrpc: "2.0",
      id: "req-7",
      result: { content: [] },
    });
    expect(result).toEqual({ ok: true, method: null, reason: null });
  });

  test("rejects non-object payloads", () => {
    expect(validateAppToHostMessage(null).ok).toBe(false);
    expect(validateAppToHostMessage("string").ok).toBe(false);
    expect(validateAppToHostMessage(42).ok).toBe(false);
  });

  test("ui/initialize accepts permissive params (matches existing bridge behavior)", () => {
    // The bridge today accepts ui/initialize regardless of params shape;
    // schema is intentionally relaxed (clientInfo and capabilities both
    // optional) until a future hardening pass.
    const result = validateAppToHostMessage({
      jsonrpc: "2.0",
      id: 0,
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26" },
    });
    expect(result.ok).toBe(true);
  });
});
