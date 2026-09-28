/**
 * Self-tests for `scripts/check-route-middleware.ts`.
 *
 * `findSubAppUse` is exercised on in-memory text; `scan` on a planted tree and
 * on this repo's own `src/`, which must be clean.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSubAppUse, scan } from "../../../scripts/check-route-middleware.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const WILDCARD_ROUTER = `import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.ts";

export function planted(ctx: AppContext) {
  return new Hono()
    .use("*", requireAuth(ctx.authOptions))
    .get("/v1/planted", (c) => c.json({}));
}
`;

const PER_ROUTE_ROUTER = `import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.ts";

export function planted(ctx: AppContext) {
  return new Hono().get("/v1/planted", requireAuth(ctx.authOptions), (c) => c.json({}));
}
`;

describe("findSubAppUse", () => {
  test('flags a sub-app .use("*")', () => {
    expect(findSubAppUse("r.ts", WILDCARD_ROUTER)).toEqual([
      { file: "r.ts", line: 6, snippet: '.use("*", requireAuth(ctx.authOptions))' },
    ]);
  });

  test("flags a path-less .use(mw) and a statement-form app.use", () => {
    const text = `import { Hono } from "hono";\nconst app = new Hono();\napp.use(mw);\napp.use("/v1/*", mw);\n`;
    expect(findSubAppUse("r.ts", text).map((v) => v.line)).toEqual([3, 4]);
  });

  test("passes middleware chained on the route", () => {
    expect(findSubAppUse("r.ts", PER_ROUTE_ROUTER)).toEqual([]);
  });

  test("ignores a file that does not import hono", () => {
    expect(findSubAppUse("r.ts", `marked.use(extension);\n`)).toEqual([]);
  });
});

describe("scan", () => {
  const root = mkdtempSync(join(tmpdir(), "nb-check-route-middleware-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("fails on a .use(\"*\") planted in a route file, and allows app.ts's global middleware", () => {
    mkdirSync(join(root, "src", "api", "routes"), { recursive: true });
    writeFileSync(join(root, "src", "api", "routes", "planted.ts"), WILDCARD_ROUTER);
    writeFileSync(
      join(root, "src", "api", "app.ts"),
      `import { Hono } from "hono";\nconst app = new Hono();\napp.use("*", cors());\n`,
    );
    expect(scan(root).map((v) => `${v.file}:${v.line}`)).toEqual([
      join("src", "api", "routes", "planted.ts:6"),
    ]);
  });

  test("passes on this repo's src/", () => {
    expect(scan(REPO_ROOT)).toEqual([]);
  });
});
