import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  browserBindingMatches,
  buildFlowCookie,
  flowCookieName,
  mintBrowserBinding,
  readCookie,
  readFlowCookie,
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
    expect(browserBindingMatches(header, NAME, false, [other.bindingHash, mine.bindingHash])).toBe(
      true,
    );
  });

  test("refuses a cookie built from the flow's lookup key", () => {
    // The key (OAuth state, Composio nonce) rides in the URL; its hash is what
    // anyone holding the URL can compute.
    const state = "S".repeat(43);
    const issued = mintBrowserBinding();
    expect(browserBindingMatches(`${NAME}=${sha(state)}`, NAME, false, [issued.bindingHash])).toBe(
      false,
    );
  });

  test("refuses the recorded hash presented as the cookie", () => {
    const issued = mintBrowserBinding();
    expect(
      browserBindingMatches(`${NAME}=${issued.bindingHash}`, NAME, false, [issued.bindingHash]),
    ).toBe(false);
  });

  test("refuses an absent, empty, malformed or differently named cookie, and an empty binding set", () => {
    const issued = mintBrowserBinding();
    const hashes = [issued.bindingHash];
    expect(browserBindingMatches(undefined, NAME, false, hashes)).toBe(false);
    expect(browserBindingMatches("", NAME, false, hashes)).toBe(false);
    expect(browserBindingMatches(`${NAME}=`, NAME, false, hashes)).toBe(false);
    expect(
      browserBindingMatches(`${NAME}=${issued.cookieValue.toUpperCase()}`, NAME, false, hashes),
    ).toBe(false);
    expect(browserBindingMatches(`${NAME}=${issued.cookieValue}00`, NAME, false, hashes)).toBe(
      false,
    );
    expect(browserBindingMatches(`other=${issued.cookieValue}`, NAME, false, hashes)).toBe(false);
    expect(browserBindingMatches(`${NAME}=${issued.cookieValue}`, NAME, false, [])).toBe(false);
  });

  test("a malformed recorded hash is skipped, never compared", () => {
    const issued = mintBrowserBinding();
    expect(
      browserBindingMatches(`${NAME}=${issued.cookieValue}`, NAME, false, [
        "short",
        issued.bindingHash,
      ]),
    ).toBe(true);
  });

  test("a Secure flow cookie takes the __Host- name; one that is not keeps the bare name", () => {
    expect(flowCookieName(NAME, true)).toBe(`__Host-${NAME}`);
    expect(flowCookieName(NAME, false)).toBe(NAME);
    expect(buildFlowCookie(NAME, "v", 900, true)).toBe(
      `__Host-${NAME}=v; HttpOnly; SameSite=Lax; Path=/; Max-Age=900; Secure`,
    );
    expect(buildFlowCookie(NAME, "", 0, false)).toBe(
      `${NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    );
  });

  test("the read names the cookie the write set", () => {
    const issued = mintBrowserBinding();
    const prefixed = `__Host-${NAME}=${issued.cookieValue}`;
    const bare = `${NAME}=${issued.cookieValue}`;
    expect(readFlowCookie(prefixed, NAME, true)).toBe(issued.cookieValue);
    expect(readFlowCookie(bare, NAME, true)).toBeNull();
    expect(readFlowCookie(prefixed, NAME, false)).toBeNull();
    expect(browserBindingMatches(prefixed, NAME, true, [issued.bindingHash])).toBe(true);
    expect(browserBindingMatches(bare, NAME, true, [issued.bindingHash])).toBe(false);
    expect(browserBindingMatches(bare, NAME, false, [issued.bindingHash])).toBe(true);
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
