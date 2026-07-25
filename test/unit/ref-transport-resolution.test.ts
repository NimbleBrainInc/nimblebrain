/**
 * What a persisted `BundleRef` resolves to at start: which transport config, and
 * whether it earns the in-cluster plain-HTTP exception.
 *
 * Both properties are pinned here because both were defects. The transport map
 * is what lets a pre-seam Composio ref authenticate from a declared credential;
 * the `fleetInternal` derivation is a security control that this PR narrowed
 * after `auth.type === "provider"` stopped meaning "operator-vetted catalog
 * entry". Reverting either leaves every other suite green.
 */

import { describe, expect, it } from "bun:test";
import { resolveRefTransport } from "../../src/bundles/startup.ts";
import type { BundleRef } from "../../src/bundles/types.ts";
import { validateBundleUrl } from "../../src/bundles/url-validator.ts";

type UrlRef = Extract<BundleRef, { url: string }>;

const IN_CLUSTER = new URL("http://composio-session.mcp-shared.svc.cluster.local/mcp");

function ref(transport: UrlRef["transport"]): UrlRef {
  return { url: "https://composio.test/mcp", serverName: "gmail", transport } as UrlRef;
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal legacy placeholder
const LEGACY_VALUE = "${COMPOSIO_API_KEY}";

describe("transport: legacy Composio refs map forward", () => {
  it("rewrites the pre-seam env-template auth to name the provider", () => {
    const { transportConfig } = resolveRefTransport(
      ref({ type: "streamable-http", auth: { type: "header", name: "x-api-key", value: LEGACY_VALUE } }),
    );
    expect(transportConfig?.auth).toEqual({
      type: "provider",
      provider: "composio",
      config: {},
    });
  });

  it("leaves a post-seam ref and an unrelated ref alone", () => {
    const post = ref({
      type: "streamable-http",
      auth: { type: "provider", provider: "composio", config: {} },
    });
    const bearer = ref({ type: "streamable-http", auth: { type: "bearer", token: "t" } });
    expect(resolveRefTransport(post).transportConfig).toBe(post.transport);
    expect(resolveRefTransport(bearer).transportConfig).toBe(bearer.transport);
  });
});

describe("fleetInternal: only the minted rail earns the in-cluster exception", () => {
  it("grants it to a minted ref — and the URL gate then admits plain HTTP in-cluster", () => {
    const { fleetInternal } = resolveRefTransport(
      ref({ type: "streamable-http", auth: { type: "provider", provider: "minted", config: {} } }),
    );
    expect(fleetInternal).toBe(true);
    expect(() =>
      validateBundleUrl(IN_CLUSTER, { allowInsecure: false, fleetInternal }),
    ).not.toThrow();
  });

  it("denies it to a brokered Composio ref — its URL comes from a vendor response", () => {
    // The regression this guards: keying on `auth.type === "provider"` would
    // grant the exception here, letting a hostile session URL reach an
    // in-cluster service over plain HTTP.
    const { fleetInternal } = resolveRefTransport(
      ref({ type: "streamable-http", auth: { type: "provider", provider: "composio", config: {} } }),
    );
    expect(fleetInternal).toBe(false);
    expect(() => validateBundleUrl(IN_CLUSTER, { allowInsecure: false, fleetInternal })).toThrow();
  });

  it("denies it to a legacy Composio ref, which maps to composio provider auth", () => {
    const { fleetInternal } = resolveRefTransport(
      ref({ type: "streamable-http", auth: { type: "header", name: "x-api-key", value: LEGACY_VALUE } }),
    );
    expect(fleetInternal).toBe(false);
  });

  it("denies it to every non-provider shape", () => {
    for (const auth of [
      { type: "bearer", token: "t" },
      { type: "header", name: "x-other", value: "v" },
      { type: "none" },
    ] as const) {
      expect(resolveRefTransport(ref({ type: "streamable-http", auth })).fleetInternal).toBe(false);
    }
    expect(resolveRefTransport(ref(undefined)).fleetInternal).toBe(false);
  });
});
