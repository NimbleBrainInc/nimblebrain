import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  browserBindingMatches,
  buildFlowCookie,
  mintBrowserBinding,
  readCookie,
} from "../../src/oauth/flow-binding.ts";
import {
  _clearAll,
  addBrowserBinding,
  flowBrowserBindings,
  register,
} from "../../src/tools/oauth-flow-registry.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const NAME = "nb_test_state";

describe("flow binding", () => {
  test("a minted binding is a random 32-byte cookie and its sha256", () => {
    const a = mintBrowserBinding();
    const b = mintBrowserBinding();
    expect(a.cookieValue).toMatch(/^[0-9a-f]{64}$/);
    expect(a.bindingHash).toBe(sha(a.cookieValue));
    expect(b.cookieValue).not.toBe(a.cookieValue);
  });

  test("admits the issued cookie, among several recorded bindings", () => {
    const mine = mintBrowserBinding();
    const other = mintBrowserBinding();
    const header = `x=1; ${NAME}=${mine.cookieValue}; y=2`;
    expect(browserBindingMatches(header, NAME, [other.bindingHash, mine.bindingHash])).toBe(true);
  });

  test("refuses a cookie built from the flow's lookup key", () => {
    // The key (OAuth state, Composio nonce) rides in the URL; its hash is what
    // anyone holding the URL can compute.
    const state = "S".repeat(43);
    const issued = mintBrowserBinding();
    expect(browserBindingMatches(`${NAME}=${sha(state)}`, NAME, [issued.bindingHash])).toBe(false);
  });

  test("refuses the recorded hash presented as the cookie", () => {
    const issued = mintBrowserBinding();
    expect(browserBindingMatches(`${NAME}=${issued.bindingHash}`, NAME, [issued.bindingHash])).toBe(
      false,
    );
  });

  test("refuses an absent, empty, malformed or differently named cookie, and an empty binding set", () => {
    const issued = mintBrowserBinding();
    const hashes = [issued.bindingHash];
    expect(browserBindingMatches(undefined, NAME, hashes)).toBe(false);
    expect(browserBindingMatches("", NAME, hashes)).toBe(false);
    expect(browserBindingMatches(`${NAME}=`, NAME, hashes)).toBe(false);
    expect(browserBindingMatches(`${NAME}=${issued.cookieValue.toUpperCase()}`, NAME, hashes)).toBe(
      false,
    );
    expect(browserBindingMatches(`${NAME}=${issued.cookieValue}00`, NAME, hashes)).toBe(false);
    expect(browserBindingMatches(`other=${issued.cookieValue}`, NAME, hashes)).toBe(false);
    expect(browserBindingMatches(`${NAME}=${issued.cookieValue}`, NAME, [])).toBe(false);
  });

  test("a malformed recorded hash is skipped, never compared", () => {
    const issued = mintBrowserBinding();
    expect(
      browserBindingMatches(`${NAME}=${issued.cookieValue}`, NAME, ["short", issued.bindingHash]),
    ).toBe(true);
  });

  test("buildFlowCookie scopes the cookie to its callback path", () => {
    expect(buildFlowCookie(NAME, "/v1/cb", "v", 900, false)).toBe(
      `${NAME}=v; HttpOnly; SameSite=Lax; Path=/v1/cb; Max-Age=900`,
    );
    expect(buildFlowCookie(NAME, "/v1/cb", "", 0, true)).toEndWith("Max-Age=0; Secure");
  });

  test("readCookie finds a cookie by exact name", () => {
    expect(readCookie("a=1; ab=2; b=3", "ab")).toBe("2");
    expect(readCookie("a=1", "b")).toBeNull();
    expect(readCookie(undefined, "a")).toBeNull();
  });
});

describe("oauth-flow-registry browser bindings", () => {
  afterEach(() => _clearAll());

  test("a flow records a binding per initiate; none for an unknown flow", () => {
    expect(addBrowserBinding("no-such-state", mintBrowserBinding().bindingHash)).toBe(false);
    expect(flowBrowserBindings("no-such-state")).toBeNull();

    register("state-1", { kind: "workspace", wsId: "ws_0076759dbbe19fcc" }, "granola").catch(
      () => {},
    );
    expect(flowBrowserBindings("state-1")?.size).toBe(0);
    const a = mintBrowserBinding();
    const b = mintBrowserBinding();
    expect(addBrowserBinding("state-1", a.bindingHash)).toBe(true);
    expect(addBrowserBinding("state-1", b.bindingHash)).toBe(true);
    expect([...(flowBrowserBindings("state-1") ?? [])]).toEqual([a.bindingHash, b.bindingHash]);
  });
});
