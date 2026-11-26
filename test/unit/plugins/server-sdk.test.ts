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
    expect(contractSchema(CONTRACT, "create", "input")).toBe(CONTRACT.$defs.create_input!);
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
