import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type ContractDocument,
  callContext,
  contractSchema,
  refuseUnlessAllowed,
  toolError,
  toolsOf,
  toolVisibility,
} from "../../../packages/plugin-sdk/src/index.ts";

const CONTRACT = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../../../schemas/contracts/conversations/v1/contract.json"),
    "utf-8",
  ),
) as ContractDocument;

const meta = (scope: unknown) => ({ "ai.nimblebrain/scope": scope });

describe("callContext", () => {
  test("reads the context from request metadata", () => {
    expect(
      callContext({
        meta: meta({ workspaceId: "ws_1", ownerId: "u", conversationId: "c", principal: "host" }),
      }),
    ).toEqual({ workspaceId: "ws_1", ownerId: "u", conversationId: "c", principal: "host" });
  });

  test("reads the context from headers when the metadata states none", () => {
    const headers = new Headers({
      "x-nb-workspace-id": "ws_2",
      "x-nb-owner-id": "u2",
      "x-nb-principal": "person",
    });
    expect(callContext({ meta: {}, headers })).toEqual({
      workspaceId: "ws_2",
      ownerId: "u2",
      principal: "person",
    });
    expect(callContext({ meta: meta({ workspaceId: "ws_m" }), headers })).toEqual({
      workspaceId: "ws_m",
    });
  });

  test("drops a principal it does not know, and empty or non-string fields", () => {
    expect(
      callContext({ meta: meta({ workspaceId: "", ownerId: 7, principal: "admin" }) }),
    ).toEqual({});
    expect(callContext({})).toEqual({});
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
