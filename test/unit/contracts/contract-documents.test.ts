import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ROOT = resolve(import.meta.dir, "../../..");

interface ToolEntry {
  visibility: string;
  unattended: string;
  input: { $ref: string };
  output: { $ref: string };
}

interface Document {
  $id: string;
  contract: string;
  version: string;
  cardinality: string;
  grants: boolean;
  tools: Record<string, ToolEntry>;
  errors: { public: Array<{ code: string; prefix?: string }>; private: Array<{ code: string }> };
  $defs: Record<string, Record<string, unknown>>;
}

const read = (path: string) => JSON.parse(readFileSync(resolve(ROOT, path), "utf-8")) as Document;

const DOCUMENTS = {
  conversations: read("schemas/contracts/conversations/v1/contract.json"),
  tasks: read("schemas/contracts/tasks/v1/contract.json"),
};

function compiler() {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  return ajv;
}

describe.each(Object.entries(DOCUMENTS))("the %s contract document", (_name, doc) => {
  test("compiles whole in Ajv 2020, and each $defs entry resolves by its URL", () => {
    const ajv = compiler();
    expect(() => ajv.compile(doc)).not.toThrow();
    for (const key of Object.keys(doc.$defs)) {
      expect(ajv.getSchema(`${doc.$id}#/$defs/${key}`)).toBeFunction();
    }
  });

  test("every tool's $ref resolves to a self-contained object schema", () => {
    for (const [tool, entry] of Object.entries(doc.tools)) {
      for (const kind of ["input", "output"] as const) {
        expect(entry[kind].$ref).toBe(`#/$defs/${tool}_${kind}`);
        const schema = doc.$defs[`${tool}_${kind}`];
        expect(schema).toBeDefined();
        expect(schema?.type).toBe("object");
        expect(JSON.stringify(schema)).not.toContain('"$ref"');
      }
    }
  });

  test("every tool states its visibility and unattended marking, and a private tool is refused", () => {
    for (const entry of Object.values(doc.tools)) {
      expect(["public", "private"]).toContain(entry.visibility);
      expect(["allowed", "refused"]).toContain(entry.unattended);
      if (entry.visibility === "private") expect(entry.unattended).toBe("refused");
    }
  });

  test("states whether it needs run grants, and every public error has a prefix", () => {
    expect(typeof doc.grants).toBe("boolean");
    for (const error of doc.errors.public) expect(error.prefix).toBeString();
  });
});

describe("the tasks contract document", () => {
  const doc = DOCUMENTS.tasks;
  const ajv = compiler();
  ajv.compile(doc);
  const schema = (key: string) => {
    const validate = ajv.getSchema(`${doc.$id}#/$defs/${key}`);
    if (!validate) throw new Error(`no $defs entry ${key}`);
    return validate;
  };

  test("names the contract and states its own URL", () => {
    expect(doc.contract).toBe("ai.nimblebrain.tasks");
    expect(doc.$id).toBe("https://schemas.nimblebrain.ai/contracts/tasks/v1/contract.json");
    expect(doc.version).toBe("1.0");
    expect(doc.cardinality).toBe("singleton");
    expect(doc.grants).toBe(true);
  });

  test("lets an unattended run read and cancel, and refuses every tool that authors or starts work", () => {
    const by = (unattended: string) =>
      Object.entries(doc.tools)
        .filter(([, t]) => t.visibility === "public" && t.unattended === unattended)
        .map(([name]) => name)
        .sort();
    expect(by("allowed")).toEqual([
      "batch",
      "batches",
      "cancel",
      "list",
      "run_result",
      "runs",
      "stats",
      "status",
      "upcoming",
    ]);
    expect(by("refused")).toEqual([
      "batch_control",
      "create",
      "delete",
      "run",
      "run_batch",
      "update",
    ]);
  });

  test("has the private tools of the run flow", () => {
    const privateTools = Object.entries(doc.tools)
      .filter(([, t]) => t.visibility === "private")
      .map(([name]) => name)
      .sort();
    expect(privateTools).toEqual([
      "begin_run",
      "check_runs",
      "delete_workspace",
      "due",
      "end_run",
      "expire",
      "offer_event",
    ]);
  });

  test("begin_run answers a skip or an agent work spec carrying its grant", () => {
    const output = schema("begin_run_output");
    expect(output({ decision: "skip", reason: "disabled" })).toBe(true);
    const work = { kind: "agent", runId: "run_1", grant: "g", prompt: "Summarize." };
    expect(output({ decision: "run", work })).toBe(true);
    expect(output({ decision: "run", work: { ...work, kind: "call" } })).toBe(false);
    const { grant: _grant, ...withoutGrant } = work;
    expect(output({ decision: "run", work: withoutGrant })).toBe(false);
  });

  test("end_run takes the closed outcome and refuses a field it does not define", () => {
    const input = schema("end_run_input");
    const outcome = {
      startedAt: "2026-01-01T09:00:00.000Z",
      endedAt: "2026-01-01T09:01:00.000Z",
      output: "done",
      stopReason: "complete",
      usage: { inputTokens: 10, outputTokens: 5, iterations: 1 },
      costUsd: 0.01,
      limits: { maxIterations: 25, maxRunDurationMs: 120000 },
      toolCalls: [{ name: "files__write", ok: true, ms: 12 }],
      filesWritten: [{ uri: "files://f1", name: "report.md" }],
      skillsDelivered: [],
    };
    expect(input({ runId: "run_1", token: 3, outcome })).toBe(true);
    expect(input({ runId: "run_1", token: 3, outcome: { ...outcome, stopReason: "paused" } })).toBe(
      false,
    );
    const withInput = { ...outcome, toolCalls: [{ name: "x", ok: true, ms: 1, input: {} }] };
    expect(input({ runId: "run_1", token: 3, outcome: withInput })).toBe(false);
    expect(input({ runId: "run_1", token: 3, outcome: { ...outcome, startedAt: "today" } })).toBe(
      false,
    );
  });

  test("no public output carries a grant", () => {
    for (const [tool, entry] of Object.entries(doc.tools)) {
      if (entry.visibility !== "public") continue;
      expect(JSON.stringify(doc.$defs[`${tool}_output`])).not.toContain('"grant"');
    }
  });
});

describe("the host context schema", () => {
  const validate = compiler().compile(
    JSON.parse(
      readFileSync(resolve(ROOT, "schemas/host-context/v1/host-context.schema.json"), "utf-8"),
    ),
  );

  test("accepts an optional grant and unattended flag", () => {
    expect(validate({ principal: "person", workspaceId: "ws_1", ownerId: "u", grant: "g" })).toBe(
      true,
    );
    expect(validate({ principal: "person", unattended: true })).toBe(true);
    expect(validate({ principal: "person", grant: "" })).toBe(false);
    expect(validate({ principal: "person", unattended: "yes" })).toBe(false);
  });
});
