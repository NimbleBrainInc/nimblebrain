import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {
  type ContractDocument,
  contractSchema,
  HOST_CONTEXT_META_KEY,
  isHost,
  readHostContext,
  refuseUnlessAllowed,
  toolError,
  toolsOf,
  toolVisibility,
} from "../../../packages/server-sdk/src/index.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const json = (path: string) => JSON.parse(readFileSync(resolve(ROOT, path), "utf-8"));

const CONTRACT = json("schemas/contracts/conversations/v1/contract.json") as ContractDocument;
const TASKS = json("schemas/contracts/tasks/v1/contract.json") as ContractDocument;
const HOST_CONTEXT_SCHEMA = json("schemas/host-context/v1/host-context.schema.json");
const validate = new Ajv2020({ strict: true }).compile(HOST_CONTEXT_SCHEMA);

const meta = (context: unknown) => ({ [HOST_CONTEXT_META_KEY]: context });

/**
 * Values at `params._meta["ai.nimblebrain/context"]`. A reader in any language is held to the
 * schema with fixtures like these: it reads what the schema accepts, and nothing else.
 */
const FIXTURES: unknown[] = [
  { principal: "host" },
  { principal: "person", workspaceId: "ws_1", ownerId: "u", conversationId: "conv_1" },
  { principal: "person", workspaceId: "ws_1", unknownField: { anything: true } },
  {},
  { workspaceId: "ws_1", ownerId: "u" },
  { principal: "admin", workspaceId: "ws_1" },
  { principal: "host", workspaceId: "" },
  { principal: "host", ownerId: 7 },
  { principal: "person", conversationId: null },
  { principal: "person", workspaceId: "ws_1", ownerId: "u", grant: "opaque.grant" },
  { principal: "person", unattended: true },
  { principal: "person", unattended: false },
  { principal: "person", grant: "" },
  { principal: "person", grant: "g".repeat(4097) },
  { principal: "person", grant: 7 },
  { principal: "person", unattended: "true" },
  null,
  "host",
  ["host"],
];

describe("the host context", () => {
  test("is published with its own $id under host-context/v1", () => {
    expect(HOST_CONTEXT_SCHEMA.$id).toBe(
      "https://schemas.nimblebrain.ai/host-context/v1/host-context.schema.json",
    );
  });

  test("the reader accepts exactly what the published schema accepts", () => {
    for (const value of FIXTURES) {
      const read = readHostContext(meta(value));
      expect({ value, read: read !== undefined }).toEqual({ value, read: validate(value) });
    }
  });

  test("the reader returns the schema's fields and ignores unknown ones", () => {
    expect(readHostContext(meta(FIXTURES[1]))).toEqual({
      principal: "person",
      workspaceId: "ws_1",
      ownerId: "u",
      conversationId: "conv_1",
    });
    expect(readHostContext(meta(FIXTURES[2]))).toEqual({
      principal: "person",
      workspaceId: "ws_1",
    });
    expect(
      readHostContext(meta({ principal: "person", grant: "opaque.grant", unattended: true })),
    ).toEqual({ principal: "person", grant: "opaque.grant", unattended: true });
    expect(readHostContext({})).toBeUndefined();
    expect(readHostContext({ "ai.nimblebrain/scope": { principal: "host" } })).toBeUndefined();
  });

  test("a call that names no principal is not host", () => {
    expect(readHostContext(meta({ workspaceId: "ws_1", ownerId: "u" }))).toBeUndefined();
    expect(isHost(readHostContext(meta({ workspaceId: "ws_1", ownerId: "u" })) ?? {})).toBe(false);
    expect(isHost(readHostContext(undefined) ?? {})).toBe(false);
  });
});

describe("the principal rule", () => {
  test("takes visibility from the contract document", () => {
    expect(toolsOf(CONTRACT, "private")).toEqual([
      "create",
      "events",
      "append_events",
      "delete",
      "delete_workspace",
    ]);
    expect(toolVisibility(CONTRACT, "list")).toBe("public");
    expect(toolVisibility(CONTRACT, "toString")).toBeUndefined();
    const listed = contractSchema(CONTRACT, "create", "input");
    expect(listed).toEqual(CONTRACT.$defs.create_input!);
    expect(listed).not.toBe(CONTRACT.$defs.create_input!);
  });

  test("lists a schema that refers to shared $defs with them bundled, so it compiles alone", () => {
    const listed = contractSchema(TASKS, "begin_run", "output");
    expect(Object.keys(listed.$defs as object).sort()).toEqual(["notice", "work_spec"]);
    const validate = new Ajv2020({ strict: false }).compile(listed);
    const run = { decision: "run", runId: "run_1", grant: "g" };
    const work = { kind: "agent", prompt: "Summarize." };
    expect(validate({ ...run, work })).toBe(true);
    expect(validate({ ...run, work: { ...work, extra: 1 } })).toBe(false);
    expect(contractSchema(TASKS, "list", "input")).toEqual(TASKS.$defs.list_input!);
    (listed.$defs as Record<string, Record<string, unknown>>).notice!.title = "changed";
    expect((TASKS.$defs.notice as Record<string, unknown>).title).not.toBe("changed");
  });

  test("refuses a private tool to anyone but the host, and nothing else", () => {
    const forbidden = refuseUnlessAllowed(CONTRACT, "events", { principal: "person" });
    expect(JSON.parse(forbidden!.content[0]!.text).code).toBe("forbidden");
    expect(refuseUnlessAllowed(CONTRACT, "events", {})).not.toBeNull();
    expect(refuseUnlessAllowed(CONTRACT, "events", { principal: "host" })).toBeNull();
    expect(refuseUnlessAllowed(CONTRACT, "list", { principal: "person" })).toBeNull();
  });

  test("an error is isError with a JSON {code, error} text", () => {
    expect(toolError("scope_missing", "no workspace")).toEqual({
      content: [{ type: "text", text: '{"code":"scope_missing","error":"no workspace"}' }],
      isError: true,
    });
  });
});
