/**
 * The `secrets` subcommand is an OPERATOR tool and must never reach the agent.
 *
 * The temptation is structural, not hypothetical: the runtime's whole shape is
 * "the agent reaches tools", so a `secrets` source is the obvious next step for
 * anyone who wants an agent to help with credentials. A tool the model can call
 * is a tool a prompt injection can call, and a read across all three scopes
 * turns any injection into credential exfiltration — including the instance
 * keys that belong to the deployment rather than to any tenant.
 *
 * What already exists and is fine: `manage_connectors set_secret`, which is
 * workspace-scoped, gated on workspace admin, and never returns a value. This
 * test is the floor under that: the surface may keep that one and grow no
 * other.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { ensureUserWorkspace } from "../../src/workspace/provisioning.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

let runtime: Runtime;
let testDir: string;
let toolNames: string[];

beforeAll(async () => {
  testDir = mkdtempSync(join(tmpdir(), "secrets-not-a-tool-"));
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir: testDir,
  });
  await ensureUserWorkspace(runtime.getWorkspaceStore(), {
    id: DEV_IDENTITY.id,
    displayName: DEV_IDENTITY.displayName,
  });
  const wsId = personalWorkspaceIdFor(DEV_IDENTITY.id);
  toolNames = (await runtime.listToolsForWorkspace(wsId, DEV_IDENTITY.id)).map((t) => t.name);
});

afterAll(async () => {
  await runtime?.stop?.();
  rmSync(testDir, { recursive: true, force: true });
});

test("no tool comes from a `secrets` source", () => {
  // The source segment is the door. A `secrets__*` name means someone
  // registered the operator command as a tool source.
  expect(toolNames.filter((name) => name.startsWith("secrets__"))).toEqual([]);
});

test("no tool reads a secret back", () => {
  // `set_secret` is the reviewed write. A *read* has no legitimate agent-facing
  // form at all: a connector uses a secret through the transport, at the moment
  // of the request, and the store hands it a `Redacted` that audits the reveal.
  const readers = ["get_secret", "read_secret", "reveal_secret", "secrets_get", "show_secret"];
  for (const reader of readers) {
    expect(toolNames.some((name) => name.endsWith(`__${reader}`))).toBe(false);
  }
});

test("the only secret-shaped tool surface is manage_connectors", () => {
  // A whole-surface sweep rather than a denylist, so a tool named something
  // nobody predicted still trips this.
  const secretish = toolNames.filter((name) => /secret|credential/i.test(name));
  expect(secretish.filter((name) => !name.startsWith("manage_connectors"))).toEqual([]);
});

test("nothing under src/tools or src/platform imports the operator command", async () => {
  // The registry assertions above catch a source that was registered. This
  // catches the step before it: a tool module reaching into `cli/secrets.ts`
  // for its store-opening or scope-parsing helpers, which is how the surface
  // grows by accident rather than by decision.
  // Matches an import or a dynamic import, not a mention: a doc comment
  // pointing an operator at the command is the opposite of the problem, and a
  // check that flagged one would be worked around by rewording the comment.
  const IMPORTS_THE_COMMAND = /(?:\bfrom|\bimport\s*\()\s*["'][^"']*cli\/secrets(?:\.ts)?["']/;
  const { Glob } = await import("bun");
  const root = join(import.meta.dir, "..", "..", "src");
  const offenders: string[] = [];
  for (const dir of ["tools", "platform"]) {
    for await (const file of new Glob("**/*.ts").scan({ cwd: join(root, dir), absolute: true })) {
      if (IMPORTS_THE_COMMAND.test(await Bun.file(file).text())) offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});
