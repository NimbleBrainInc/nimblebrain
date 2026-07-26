/**
 * Marker semantics, per corpus.
 *
 * A personal connector surfaces under the reserved `my_` marker; a workspace
 * source does not. Every place that BUILDS a set of tool names, and every place
 * that MATCHES a pattern against one, therefore has to answer the same question:
 * are marked names in this set, and can a pattern reach them?
 *
 * That question was answered ad hoc, one site at a time, across six review
 * rounds — strip here, keep there, and the decision re-derived each time from
 * scratch. The failures were always the same shape and always silent: a matcher
 * that stripped too much, a corpus that included too much, a broadcast key that
 * did not agree with the key it was compared to.
 *
 * So the rule, written down once:
 *
 *   **Every corpus and every pattern-matching seam states its marker semantics
 *   explicitly, and carries a test here.**
 *
 * Adding a new corpus or matcher means adding a case below. If you cannot say in
 * one line whether marked names belong in it, that is the finding.
 *
 * | Seam | Marked names present? | Reachable by a bare pattern? |
 * |---|---|---|
 * | `Runtime.defaultActiveTools` (delegate default) | no | n/a |
 * | `IdentityToolRouter.availableTools` (reachable set) | yes | **no** — marked glob only |
 * | `listToolsForWorkspace` (the wire surface) | yes | n/a — not pattern-matched |
 * | `toolNameMatchesPattern` (allowedTools, toolAffinity, delegate globs) | n/a | bare pattern yes, NORMALIZED pattern no |
 * | `deriveDataChangedTarget` (SSE broadcast key) | yes, and NOT stripped | n/a — a marked name gets no broadcast |
 */

import { describe, expect, test } from "bun:test";
import { deriveDataChangedTarget } from "../../../src/api/events.ts";
import { PERSONAL_CONNECTOR_PREFIX } from "../../../src/tools/identity-sources.ts";
import { filterTools } from "../../../src/tools/surfacing.ts";
import { toolNameMatchesPattern } from "../../../src/tools/tool-pattern.ts";

const WORKSPACE_TOOL = "crm__search";
const KERNEL_TOOL = "conversations__list";
const MARKED_TOOL = `${PERSONAL_CONNECTOR_PREFIX}gmail__send`;

/** The reachable corpus: workspace + kernel + the caller's granted connectors. */
const REACHABLE = [WORKSPACE_TOOL, KERNEL_TOOL, MARKED_TOOL].map((name) => ({
  name,
  description: "",
  inputSchema: {},
})) as never[];

/**
 * The delegate corpus rule, applied as `selectChildTools` applies it: a marked
 * name survives only if a glob that literally carries the marker matched it.
 */
function delegateSelection(globs: string[]): string[] {
  const marked = globs.filter((g) => g.startsWith(PERSONAL_CONNECTOR_PREFIX));
  return filterTools(REACHABLE, globs)
    .map((t: { name: string }) => t.name)
    .filter(
      (n) =>
        !n.startsWith(PERSONAL_CONNECTOR_PREFIX) ||
        marked.some((g) => toolNameMatchesPattern(n, g)),
    );
}

describe("corpus: the delegate reachable set", () => {
  test("a bare wildcard does NOT reach the parent's connectors", () => {
    // The leak this file exists to prevent: `tools: ["*"]` handing a sub-agent
    // the parent's own credentials. `Runtime.defaultActiveTools` documents the
    // exclusion as "a decision, not an accident".
    expect(delegateSelection(["*"])).toEqual([WORKSPACE_TOOL, KERNEL_TOOL]);
  });

  test("a bare suffix glob does NOT reach them either", () => {
    expect(delegateSelection(["*__send"])).toEqual([]);
  });

  test("a marked glob DOES — the documented opt-in", () => {
    expect(delegateSelection([`${PERSONAL_CONNECTOR_PREFIX}gmail__*`])).toEqual([MARKED_TOOL]);
  });

  test("a marked glob does not smuggle in workspace tools alongside", () => {
    expect(delegateSelection([`${PERSONAL_CONNECTOR_PREFIX}*`])).toEqual([MARKED_TOOL]);
  });
});

describe("seam: pattern matching", () => {
  test("a bare pattern reaches a marked name only when it is itself marked", () => {
    expect(toolNameMatchesPattern(MARKED_TOOL, "gmail__*")).toBe(false);
    expect(toolNameMatchesPattern(MARKED_TOOL, `${PERSONAL_CONNECTOR_PREFIX}gmail__*`)).toBe(true);
  });

  test("a NORMALIZED (legacy-prefixed) pattern never reaches a marked name", () => {
    // It could not have named one when it was authored — connectors were bare
    // then and `ws_<id>-…` only named workspace tools — so normalizing it must
    // not grant something its author could not write.
    expect(toolNameMatchesPattern(MARKED_TOOL, "ws_aaaaaaaaaaaaaaaa-*")).toBe(false);
    expect(toolNameMatchesPattern(WORKSPACE_TOOL, "ws_aaaaaaaaaaaaaaaa-*")).toBe(true);
  });
});

describe("seam: the data.changed broadcast key", () => {
  test("a marked name produces NO broadcast, and the marker is not stripped to find one", () => {
    // The tempting fix is to de-mark so the key matches `iframe.dataset.app`.
    // That is wrong: a personal connector cannot mount an iframe (a `ui://` read
    // resolves through the kernel identity sources or the workspace registry, and
    // a connector is in neither), so de-marking would not reach the connector's
    // own surface — it would reach a WORKSPACE app of the same name and refetch
    // an unrelated app on the caller's private tool call. Exactly the collision
    // the marker exists to prevent.
    expect(
      deriveDataChangedTarget({ type: "tool.done", data: { name: MARKED_TOOL, ok: true } } as never),
    ).toBeNull();
  });

  test("a workspace source of that name still broadcasts normally", () => {
    expect(
      deriveDataChangedTarget({ type: "tool.done", data: { name: "gmail__send", ok: true } } as never),
    ).toEqual({ server: "gmail", tool: "send" });
  });
});
