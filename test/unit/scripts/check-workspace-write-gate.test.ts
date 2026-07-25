/**
 * Self-tests for `scripts/check-workspace-write-gate.ts`.
 *
 * A lint that silently stops matching is worse than no lint — it reports
 * green while the invariant evaporates. These pin each branch of the
 * scanner, including the two blind spots the script's docstring admits to,
 * so that "we know it misses this" stays a deliberate limitation rather
 * than drifting into an unnoticed one.
 */

import { describe, expect, test } from "bun:test";
import { isTest, scanSource } from "../../../scripts/check-workspace-write-gate.ts";

const FILE = "web/src/pages/settings/Example.tsx";

describe("check-workspace-write-gate — what it flags", () => {
  test("flags a ws_admin threshold", () => {
    const found = scanSource(`const canEdit = roleAtLeast(role, "ws_admin");`, FILE);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(1);
    expect(found[0]?.file).toBe(FILE);
  });

  test("flags it regardless of what the first argument is", () => {
    expect(scanSource(`const x = roleAtLeast(useScopedRole(), "ws_admin");`, FILE)).toHaveLength(1);
  });

  test("flags every occurrence, not just the first", () => {
    const src = `
      const a = roleAtLeast(r, "ws_admin");
      const b = roleAtLeast(r, "ws_admin");
    `;
    expect(scanSource(src, FILE)).toHaveLength(2);
  });
});

describe("check-workspace-write-gate — what it leaves alone", () => {
  test("other thresholds are fine — the ordering itself isn't the bug", () => {
    expect(scanSource(`const x = roleAtLeast(role, "org_admin");`, FILE)).toHaveLength(0);
    expect(scanSource(`const x = roleAtLeast(role, "ws_member");`, FILE)).toHaveLength(0);
  });

  test("prose mentioning the call is not a call", () => {
    // The docstring makes a point of AST matching over regex precisely so
    // that documenting the rule doesn't trip it.
    const src = `
      // Never write roleAtLeast(role, "ws_admin") for a write gate.
      /** Use the hook instead of roleAtLeast(role, "ws_admin"). */
      const s = 'roleAtLeast(role, "ws_admin")';
    `;
    expect(scanSource(src, FILE)).toHaveLength(0);
  });

  test("the lint-ok marker on the line above clears it", () => {
    const src = `// lint-ok:workspace-write-gate\nconst x = roleAtLeast(role, "ws_admin");`;
    expect(scanSource(src, FILE)).toHaveLength(0);
  });

  test("the marker only applies to the line directly above", () => {
    const src = `// lint-ok:workspace-write-gate\nconst unrelated = 1;\nconst x = roleAtLeast(role, "ws_admin");`;
    expect(scanSource(src, FILE)).toHaveLength(1);
  });
});

describe("check-workspace-write-gate — documented blind spots", () => {
  // These assert what the check does NOT catch. They exist so the
  // limitation stays deliberate: if a future change makes one of these
  // detectable, this test fails and the docstring gets updated with it.

  test("does not see the bypass written longhand — where the fifth instance lived", () => {
    const src = `const isWsAdmin = isOrgAdmin || members.some((m) => m.role === "admin");`;
    expect(scanSource(src, FILE)).toHaveLength(0);
  });

  test("does not see a non-literal threshold", () => {
    const src = `const x = roleAtLeast(role, item.minRole ?? "ws_member");`;
    expect(scanSource(src, FILE)).toHaveLength(0);
  });
});

describe("check-workspace-write-gate — isTest", () => {
  test("test files are out of scope — they exercise the ordering on purpose", () => {
    expect(isTest("web/src/__tests__/useScopedRole.test.ts")).toBe(true);
    expect(isTest("web/src/lib/thing.test.ts")).toBe(true);
    expect(isTest("web/src/lib/thing.test.tsx")).toBe(true);
  });

  test("production files are in scope", () => {
    expect(isTest("web/src/pages/settings/ConnectorBrowsePage.tsx")).toBe(false);
    expect(isTest("web/src/hooks/useScopedRole.ts")).toBe(false);
    // Not fooled by a substring that isn't the suffix.
    expect(isTest("web/src/lib/test-helpers.ts")).toBe(false);
  });
});
