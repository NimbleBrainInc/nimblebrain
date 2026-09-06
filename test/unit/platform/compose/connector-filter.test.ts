/**
 * Unit coverage for `applyConnectorFilter` — the in-place narrowing the
 * `compose__effective_context` tool runs after composing, before
 * returning. Two distinct branches:
 *
 *   1. `ownConnectorMatches` — top-level `layer.connector` matches the filter.
 *      Used by `focused_app` (which records the connector the user's
 *      currently viewing) and any future layer kind that's connector-
 *      attributed at the section level rather than per-item.
 *
 *   2. Per-`subItem` matching — section keeps any subItem whose
 *      `connector` matches; subItems with no/different connector are pared.
 *      Used by `layer3_skills` (per-skill) and `apps` (per-app).
 *
 * Integration tests cover the layer3 per-subItem path end-to-end (see
 * `test/integration/compose-effective-context.test.ts`). This file
 * covers the apps per-subItem path and the ownConnectorMatches path
 * directly with constructed fixtures — exercising the full filter
 * logic without spinning up a Runtime + workspace + fake connector.
 */

import { describe, expect, test } from "bun:test";
import {
  applyConnectorFilter,
  type ComposeResponse,
} from "../../../../src/platform/compose/source.ts";
import type { TracedLayer } from "../../../../src/prompt/compose.ts";

function makeResponse(layers: TracedLayer[]): ComposeResponse {
  return {
    mode: "live",
    conversationId: "conv_aaaaaaaaaaaaaaaa",
    totalTokens: layers.reduce((s, l) => s + l.tokens, 0),
    text: layers.map((l) => l.text).join("\n\n---\n\n"),
    layers,
    warnings: [],
  };
}

describe("applyConnectorFilter", () => {
  test("apps section narrows subItems to the filtered connector", () => {
    const layer: TracedLayer = {
      kind: "apps",
      id: "nb:apps",
      source: "installed apps (2)",
      text: "## Installed Apps\n- synapse-collateral\n- synapse-crm",
      tokens: 100,
      subItems: [
        {
          kind: "app",
          id: "synapse-collateral",
          source: "synapse-collateral",
          connector: "synapse-collateral",
        },
        {
          kind: "app",
          id: "synapse-crm",
          source: "synapse-crm",
          connector: "synapse-crm",
        },
      ],
    };
    const response = makeResponse([layer]);

    applyConnectorFilter(response, "synapse-collateral");

    expect(response.layers).toHaveLength(1);
    expect(response.layers[0]!.subItems).toHaveLength(1);
    expect(response.layers[0]!.subItems![0]!.connector).toBe("synapse-collateral");
  });

  test("ownConnectorMatches branch keeps the layer wholesale (focused_app)", () => {
    // The `focused_app` layer carries the connector on the LAYER, not in subItems.
    // The filter must keep the layer entirely when its top-level `connector`
    // matches — without this branch, a focused-app row would be dropped on
    // any connector filter because its subItems are empty.
    const focusedApp: TracedLayer = {
      kind: "focused_app",
      id: "nb:focused-app",
      source: "focused app: synapse-collateral",
      text: "## Active App: synapse-collateral",
      tokens: 50,
      connector: "synapse-collateral",
    };
    const otherLayer: TracedLayer = {
      kind: "user_prefs",
      id: "nb:user-prefs",
      source: "runtime — user preferences + current date",
      text: "## User",
      tokens: 30,
    };
    const response = makeResponse([focusedApp, otherLayer]);

    applyConnectorFilter(response, "synapse-collateral");

    expect(response.layers).toHaveLength(1);
    expect(response.layers[0]!.kind).toBe("focused_app");
  });

  test("layers with no connector attribution are dropped under any filter", () => {
    const userPrefs: TracedLayer = {
      kind: "user_prefs",
      id: "nb:user-prefs",
      source: "runtime — user preferences + current date",
      text: "## User",
      tokens: 30,
    };
    const response = makeResponse([userPrefs]);

    applyConnectorFilter(response, "synapse-collateral");

    expect(response.layers).toHaveLength(0);
    expect(response.totalTokens).toBe(0);
  });

  test("mixed subItems are pared to just the matching ones", () => {
    const layer: TracedLayer = {
      kind: "layer3_skills",
      id: "nb:layer3-skills",
      source: "layer 3 skills",
      text: "## Skills\n...",
      tokens: 200,
      subItems: [
        {
          kind: "layer3_skill",
          id: "/skills/connectors/synapse-crm/rules.md",
          source: "/skills/connectors/synapse-crm/rules.md",
          connector: "synapse-crm",
        },
        {
          kind: "layer3_skill",
          id: "/skills/voice-rules.md",
          source: "/skills/voice-rules.md",
          // no connector — connector-agnostic skill
        },
        {
          kind: "layer3_skill",
          id: "/skills/connectors/synapse-collateral/rules.md",
          source: "/skills/connectors/synapse-collateral/rules.md",
          connector: "synapse-collateral",
        },
      ],
    };
    const response = makeResponse([layer]);

    applyConnectorFilter(response, "synapse-crm");

    expect(response.layers).toHaveLength(1);
    const subItems = response.layers[0]!.subItems!;
    expect(subItems).toHaveLength(1);
    expect(subItems[0]!.connector).toBe("synapse-crm");
    expect(subItems[0]!.id).toContain("synapse-crm");
  });

  test("totalTokens recomputed against surviving layers", () => {
    const matching: TracedLayer = {
      kind: "focused_app",
      id: "nb:focused-app",
      source: "focused app: x",
      text: "x",
      tokens: 10,
      connector: "synapse-crm",
    };
    const dropped: TracedLayer = {
      kind: "user_prefs",
      id: "nb:user-prefs",
      source: "runtime — user prefs",
      text: "y",
      tokens: 20,
    };
    const response = makeResponse([matching, dropped]);
    expect(response.totalTokens).toBe(30);

    applyConnectorFilter(response, "synapse-crm");

    expect(response.totalTokens).toBe(10);
  });

  test("text is rebuilt from filtered layers (response stays self-consistent)", () => {
    // Regression: earlier versions left `response.text` untouched after
    // filtering, so a caller using `r.totalTokens` (filtered) to budget
    // context against `r.text` (unfiltered) would be misled by the
    // self-inconsistent response. The filter MUST keep all three fields
    // (layers, totalTokens, text) describing the same subset.
    const kept: TracedLayer = {
      kind: "focused_app",
      id: "nb:focused-app",
      source: "focused app: synapse-crm",
      text: "## Active App: synapse-crm",
      tokens: 10,
      connector: "synapse-crm",
    };
    const dropped: TracedLayer = {
      kind: "user_prefs",
      id: "nb:user-prefs",
      source: "runtime — user prefs",
      text: "## User\n- Name: Mat",
      tokens: 20,
    };
    const response = makeResponse([kept, dropped]);

    applyConnectorFilter(response, "synapse-crm");

    expect(response.text).toBe("## Active App: synapse-crm");
    expect(response.text).not.toContain("## User");
    // And the joined text equals the layers it claims to describe.
    expect(response.text).toBe(response.layers.map((l) => l.text).join("\n\n---\n\n"));
  });
});
