#!/usr/bin/env bun
/**
 * Lint: the workspace not-found route stays INSIDE the `/w/:slug` element.
 *
 * React Router ranks branches by specificity, not source order. A `<Route
 * path="*">` at the top level therefore outranks the `/w/:slug` branch for any
 * unmatched `/w/<slug>/…` URL — the branch is never entered, so
 * `WorkspaceRouteGuard` never mounts.
 *
 * The guard is what projects the route slug onto the ambient workspace. Skip it
 * and the shell keeps serving the previously-focused workspace's placements, so
 * an app that IS installed in the workspace the URL names gets reported as gone.
 * Reachable by pressing Back after a workspace switch, or by opening a shared
 * `/w/<other>/app/<x>` link.
 *
 * This shipped wrong once already, which is why it is a gate rather than a
 * comment. It cannot be a unit test: React Router rejects a custom component
 * that returns `<Route>` elements, so the route table can't be mounted in
 * isolation without restructuring it into a `useRoutes` config.
 *
 * What this asserts, against `web/src/App.tsx`:
 *   - the `<Route path="/w/:slug">` element has a direct `<Route path="*">` child
 *   - that child renders `WorkspaceNotFoundPage` (the slug-derived settledness
 *     wrapper — the bare `NotFoundPage` would compare against lagging ambient
 *     state and paint a false "not available" mid-switch)
 *
 * It deliberately says nothing about the top-level `path="*"`, which is free to
 * move: only the nested one is order-sensitive.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const TARGET = join(ROOT, "web/src/App.tsx");
const WORKSPACE_PATH = "/w/:slug";
const SPLAT = "*";
const REQUIRED_ELEMENT = "WorkspaceNotFoundPage";

/** The literal value of a JSX attribute, or undefined when it isn't a plain string. */
function stringAttr(node: ts.JsxOpeningLikeElement, name: string): string | undefined {
  for (const prop of node.attributes.properties) {
    if (!ts.isJsxAttribute(prop) || prop.name.getText() !== name) continue;
    const init = prop.initializer;
    if (init && ts.isStringLiteral(init)) return init.text;
  }
  return undefined;
}

/** Does this `<Route>`'s `element={...}` mention `WorkspaceNotFoundPage`? */
function elementMentions(node: ts.JsxOpeningLikeElement, name: string): boolean {
  for (const prop of node.attributes.properties) {
    if (!ts.isJsxAttribute(prop) || prop.name.getText() !== "element") continue;
    return prop.initializer?.getText().includes(name) ?? false;
  }
  return false;
}

function openingOf(node: ts.Node): ts.JsxOpeningLikeElement | undefined {
  if (ts.isJsxElement(node)) return node.openingElement;
  if (ts.isJsxSelfClosingElement(node)) return node;
  return undefined;
}

const source = ts.createSourceFile(
  TARGET,
  readFileSync(TARGET, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

let workspaceRoute: ts.JsxElement | undefined;
(function find(node: ts.Node): void {
  if (ts.isJsxElement(node)) {
    const opening = node.openingElement;
    if (opening.tagName.getText() === "Route" && stringAttr(opening, "path") === WORKSPACE_PATH) {
      workspaceRoute = node;
      return;
    }
  }
  ts.forEachChild(node, find);
})(source);

if (!workspaceRoute) {
  console.error(
    `✗ check:workspace-splat-nesting — no <Route path="${WORKSPACE_PATH}"> element found in web/src/App.tsx.\n` +
      "  If the workspace route was renamed, update this check with it.",
  );
  process.exit(1);
}

const nested = workspaceRoute.children
  .map(openingOf)
  .filter((o): o is ts.JsxOpeningLikeElement => !!o)
  .filter((o) => o.tagName.getText() === "Route" && stringAttr(o, "path") === SPLAT);

if (nested.length === 0) {
  console.error(
    `✗ check:workspace-splat-nesting — <Route path="${WORKSPACE_PATH}"> has no <Route path="${SPLAT}"> child.\n\n` +
      "  A top-level splat cannot serve workspace-scoped misses: React Router ranks by\n" +
      "  specificity, so it swallows /w/<slug>/… whole and WorkspaceRouteGuard never\n" +
      "  mounts. Without the guard the shell stays on the previously-focused workspace\n" +
      "  and reports an installed app as gone. Keep the nested splat.",
  );
  process.exit(1);
}

const wrong = nested.filter((o) => !elementMentions(o, REQUIRED_ELEMENT));
if (wrong.length > 0) {
  console.error(
    `✗ check:workspace-splat-nesting — the nested <Route path="${SPLAT}"> must render ${REQUIRED_ELEMENT}.\n\n` +
      "  It derives settledness from the route slug. The bare NotFoundPage takes a\n" +
      "  `settled` prop computed from ambient workspace state, which lags a switch by a\n" +
      "  render — reporting settled while both sides still name the previous workspace,\n" +
      '  and painting "not available" for an app that is installed in the one the URL names.',
  );
  process.exit(1);
}

console.log("✓ workspace not-found route is nested under /w/:slug and slug-derived");
