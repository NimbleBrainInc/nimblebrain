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
/** The wire name a flow cookie `NAME` travels under. */
const WIRE = `__Host-${NAME}`;

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
    const header = `x=1; ${WIRE}=${mine.cookieValue}; y=2`;
    expect(browserBindingMatches(header, NAME, [other.bindingHash, mine.bindingHash])).toBe(true);
  });

  test("refuses a cookie built from the flow's lookup key", () => {
    // The key (OAuth state, Composio nonce) rides in the URL; its hash is what
    // anyone holding the URL can compute.
    const state = "S".repeat(43);
    const issued = mintBrowserBinding();
    expect(browserBindingMatches(`${WIRE}=${sha(state)}`, NAME, [issued.bindingHash])).toBe(false);
  });

  test("refuses the recorded hash presented as the cookie", () => {
    const issued = mintBrowserBinding();
    expect(browserBindingMatches(`${WIRE}=${issued.bindingHash}`, NAME, [issued.bindingHash])).toBe(
      false,
    );
  });

  test("refuses an absent, empty, malformed or differently named cookie, and an empty binding set", () => {
    const issued = mintBrowserBinding();
    const hashes = [issued.bindingHash];
    expect(browserBindingMatches(undefined, NAME, hashes)).toBe(false);
    expect(browserBindingMatches("", NAME, hashes)).toBe(false);
    expect(browserBindingMatches(`${WIRE}=`, NAME, hashes)).toBe(false);
    expect(browserBindingMatches(`${WIRE}=${issued.cookieValue.toUpperCase()}`, NAME, hashes)).toBe(
      false,
    );
    expect(browserBindingMatches(`${WIRE}=${issued.cookieValue}00`, NAME, hashes)).toBe(false);
    expect(browserBindingMatches(`other=${issued.cookieValue}`, NAME, hashes)).toBe(false);
    expect(browserBindingMatches(`${WIRE}=${issued.cookieValue}`, NAME, [])).toBe(false);
  });

  test("a malformed recorded hash is skipped, never compared", () => {
    const issued = mintBrowserBinding();
    expect(
      browserBindingMatches(`${WIRE}=${issued.cookieValue}`, NAME, ["short", issued.bindingHash]),
    ).toBe(true);
  });

  test("a flow cookie is always __Host- and Secure, Path=/, no Domain", () => {
    expect(flowCookieName(NAME)).toBe(`__Host-${NAME}`);
    expect(buildFlowCookie(NAME, "v", 900)).toBe(
      `__Host-${NAME}=v; HttpOnly; SameSite=Lax; Path=/; Max-Age=900; Secure`,
    );
    expect(buildFlowCookie(NAME, "", 0)).toBe(
      `__Host-${NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure`,
    );
  });

  test("the read names the cookie the write set; the bare name is not it", () => {
    const issued = mintBrowserBinding();
    const bare = `${NAME}=${issued.cookieValue}`;
    expect(readFlowCookie(`__Host-${bare}`, NAME)).toBe(issued.cookieValue);
    expect(readFlowCookie(bare, NAME)).toBeNull();
    expect(browserBindingMatches(`__Host-${bare}`, NAME, [issued.bindingHash])).toBe(true);
    expect(browserBindingMatches(bare, NAME, [issued.bindingHash])).toBe(false);
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
