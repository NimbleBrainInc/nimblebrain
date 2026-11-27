import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type TSchema, Type } from "@sinclair/typebox";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ContractSource } from "../../../contracts/scripts/contract-source.ts";
import { emit } from "../../../contracts/scripts/emit-contracts.ts";

const ROOT = resolve(import.meta.dir, "../../..");

interface ToolEntry {
  visibility: string;
  unattended: string;
  grant?: boolean;
  input: { $ref: string };
  output: { $ref: string };
}

interface Document {
  $id: string;
  contract: string;
  version: string;
  cardinality: string;
  tools: Record<string, ToolEntry>;
  errors: { public: Array<{ code: string; prefix?: string }>; private: Array<{ code: string }> };
  $defs: Record<string, Record<string, unknown>>;
}

const read = (path: string) => JSON.parse(readFileSync(resolve(ROOT, path), "utf-8")) as Document;

const DOCUMENTS = {
  conversations: read("schemas/contracts/conversations/v1/contract.json"),
  tasks: read("schemas/contracts/tasks/v1/contract.json"),
  files: read("schemas/contracts/files/v1/contract.json"),
};

const SHARED_DEFS = ["notice", "occurrence", "run_outcome", "work_spec"];

function compiler() {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  return ajv;
}

/** Every `$ref` value in a JSON value. */
function refsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(refsOf);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) =>
    k === "$ref" && typeof v === "string" ? [v] : refsOf(v),
  );
}

describe.each(Object.entries(DOCUMENTS))("the %s contract document", (_name, doc) => {
  test("compiles whole in Ajv 2020, and each $defs entry resolves by its URL", () => {
    const ajv = compiler();
    expect(() => ajv.compile(doc)).not.toThrow();
    for (const key of Object.keys(doc.$defs)) {
      expect(ajv.getSchema(`${doc.$id}#/$defs/${key}`)).toBeFunction();
    }
  });

  test("every tool's $ref names its object schema; only a private one refers to shared $defs", () => {
    for (const [tool, entry] of Object.entries(doc.tools)) {
      for (const kind of ["input", "output"] as const) {
        expect(entry[kind].$ref).toBe(`#/$defs/${tool}_${kind}`);
        const schema = doc.$defs[`${tool}_${kind}`];
        expect(schema?.type).toBe("object");
        expect(JSON.stringify(schema)).not.toContain('"$defs"');
        if (entry.visibility === "public") expect(refsOf(schema)).toEqual([]);
        for (const ref of refsOf(schema)) {
          const name = ref.replace("#/$defs/", "");
          expect(SHARED_DEFS).toContain(name);
          expect(doc.$defs[name]).toBeDefined();
        }
      }
    }
    for (const name of SHARED_DEFS) {
      if (doc.$defs[name]) expect(refsOf(doc.$defs[name])).toEqual([]);
    }
  });

  test("every tool states its visibility and unattended marking, and a private tool is refused", () => {
    for (const entry of Object.values(doc.tools)) {
      expect(["public", "private"]).toContain(entry.visibility);
      expect(["allowed", "refused"]).toContain(entry.unattended);
      if (entry.visibility === "private") expect(entry.unattended).toBe("refused");
    }
  });

  test("a grant sits only on a public tool refused to unattended runs", () => {
    for (const entry of Object.values(doc.tools)) {
      if (entry.grant === undefined) continue;
      expect(entry.grant).toBe(true);
      expect(entry.visibility).toBe("public");
      expect(entry.unattended).toBe("refused");
    }
  });

  test("every public error has a prefix", () => {
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
  const names = (keep: (t: ToolEntry) => boolean) =>
    Object.entries(doc.tools)
      .filter(([, t]) => keep(t))
      .map(([name]) => name)
      .sort();

  test("names the contract and states its own URL", () => {
    expect(doc.contract).toBe("ai.nimblebrain.tasks");
    expect(doc.$id).toBe("https://schemas.nimblebrain.ai/contracts/tasks/v1/contract.json");
    expect(doc.version).toBe("1.0");
    expect(doc.cardinality).toBe("singleton");
  });

  test("emits its shared schemas as named $defs", () => {
    for (const name of SHARED_DEFS) expect(doc.$defs[name]).toBeObject();
    expect(doc.$defs.begin_run_output).toMatchObject({ type: "object" });
    expect(refsOf(doc.$defs.end_run_input)).toEqual(["#/$defs/run_outcome"]);
  });

  test("lets an unattended run read, and refuses every tool that authors, starts or stops work", () => {
    const pub = (u: string) => names((t) => t.visibility === "public" && t.unattended === u);
    expect(pub("allowed")).toEqual([
      "batch",
      "batches",
      "list",
      "run_result",
      "runs",
      "stats",
      "status",
      "upcoming",
    ]);
    expect(pub("refused")).toEqual([
      "batch_control",
      "cancel",
      "create",
      "delete",
      "run",
      "run_batch",
      "update",
    ]);
  });

  test("stamps a grant on the tools that save or start work", () => {
    expect(names((t) => t.grant === true)).toEqual([
      "batch_control",
      "create",
      "run",
      "run_batch",
      "update",
    ]);
  });

  test("has the private tools of the run flow", () => {
    expect(names((t) => t.visibility === "private")).toEqual([
      "begin_run",
      "delete_workspace",
      "due",
      "end_run",
      "offer_event",
    ]);
  });

  test("every private input carries the host's version", () => {
    for (const tool of names((t) => t.visibility === "private")) {
      expect((doc.$defs[`${tool}_input`]?.required as string[]) ?? []).toContain("version");
    }
    const due = schema("due_input");
    const at = "2026-01-01T09:00:00.000Z";
    expect(due({ version: "1.0", now: at, until: at })).toBe(true);
    expect(due({ version: "2.0", now: at, until: at })).toBe(false);
    expect(due({ now: at, until: at })).toBe(false);
  });

  test("due answers occurrences that name no owner and the runs to cancel, closed", () => {
    const due = schema("due_output");
    const page = { occurrences: [{ key: "k", ref: "r" }], cancel: ["run_1"], nextCursor: null };
    expect(due(page)).toBe(true);
    const { cancel: _cancel, ...withoutCancel } = page;
    expect(due(withoutCancel)).toBe(false);
    expect(due({ ...page, occurrences: [{ key: "k", ref: "r", ownerId: "u" }] })).toBe(false);
    expect(due({ ...page, more: true })).toBe(false);
    const cancel = Array.from({ length: 1001 }, (_, i) => `run_${i}`);
    expect(due({ ...page, cancel })).toBe(true);
  });

  test("every private output is closed", () => {
    const removed = { tasks: 0, runs: 0, batches: 0 };
    expect(schema("delete_workspace_output")({ removed })).toBe(true);
    expect(schema("delete_workspace_output")({ removed, extra: 1 })).toBe(false);
    expect(schema("delete_workspace_output")({ removed: { ...removed, keys: 0 } })).toBe(false);
  });

  test("begin_run answers a skip, or a run with its id and grant beside the work", () => {
    const output = schema("begin_run_output");
    expect(output({ decision: "skip", reason: "disabled" })).toBe(true);
    const interrupted = { runId: "run_1", token: 2 };
    const notice = { id: "n1", title: "Run lost", body: "", level: "attention" };
    expect(output({ decision: "skip", reason: "lost", interrupted, notices: [notice] })).toBe(true);
    expect(output({ decision: "skip", reason: "x", grant: "g" })).toBe(false);
    const work = { kind: "agent", prompt: "Summarize." };
    const run = { decision: "run", runId: "run_1", grant: "g", work };
    expect(output(run)).toBe(true);
    expect(output({ ...run, work: { ...work, kind: "call" } })).toBe(false);
    expect(output({ ...run, work: { ...work, extra: 1 } })).toBe(false);
    expect(output({ ...run, work: { ...work, runId: "run_1" } })).toBe(false);
    const { grant: _grant, ...withoutGrant } = run;
    expect(output(withoutGrant)).toBe(false);
    const account = { id: "a", unit: "usd", remaining: -1 };
    expect(output({ ...run, work: { ...work, spendAccounts: [account] } })).toBe(false);
  });

  describe("the outcome", () => {
    const outcome = schema("run_outcome");
    const base = {
      startedAt: "2026-01-01T09:00:00.000Z",
      endedAt: "2026-01-01T09:01:00.000Z",
      output: "done",
      stopReason: "complete",
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: 0.01,
      toolCalls: [{ name: "files__write", ok: true, ms: 12 }],
      filesWritten: [{ uri: "files://f1", name: "report.md" }],
    };

    test("takes the core alone, and refuses a field it does not define", () => {
      expect(outcome(base)).toBe(true);
      expect(outcome({ ...base, stopReason: "paused" })).toBe(false);
      expect(outcome({ ...base, startedAt: "today" })).toBe(false);
      const withInput = { ...base, toolCalls: [{ name: "x", ok: true, ms: 1, input: {} }] };
      expect(outcome(withInput)).toBe(false);
      const held = { ...base, toolCalls: [{ name: "x", ok: false, ms: 1, held: true }] };
      expect(outcome(held)).toBe(false);
      const reason = (errorReason: string) => ({
        ...base,
        toolCalls: [{ name: "x", ok: false, ms: 1, errorReason }],
      });
      expect(outcome(reason("bad_input"))).toBe(true);
      expect(outcome(reason("workspace_access_denied"))).toBe(false);
    });

    test("requires an error with error, other and not_started, and refuses one with complete", () => {
      const error = { code: "interrupted", transient: true };
      for (const stopReason of ["error", "other", "not_started"]) {
        expect(outcome({ ...base, stopReason })).toBe(false);
        expect(outcome({ ...base, stopReason, error })).toBe(true);
      }
      expect(outcome({ ...base, error })).toBe(false);
      expect(outcome({ ...base, stopReason: "cancelled" })).toBe(true);
    });

    test("pairs wrapUpLimit with complete and the spend fields with spend_limit", () => {
      expect(outcome({ ...base, wrapUpLimit: "max_iterations" })).toBe(true);
      expect(outcome({ ...base, stopReason: "timeout", wrapUpLimit: "max_iterations" })).toBe(
        false,
      );
      const spend = { spendAccountId: "a", spendStop: "exhausted" };
      expect(outcome({ ...base, stopReason: "spend_limit", ...spend })).toBe(true);
      expect(outcome({ ...base, ...spend })).toBe(false);
      expect(outcome({ ...base, stopReason: "timeout", spendStop: "reserved" })).toBe(false);
    });
  });

  test("end_run takes the outcome by reference and answers closed notices", () => {
    expect(refsOf(doc.$defs.end_run_input)).toEqual(["#/$defs/run_outcome"]);
    const output = schema("end_run_output");
    const notice = { id: "n1", title: "Run failed", body: "", level: "attention" };
    expect(output({ notices: [notice] })).toBe(true);
    expect(output({ notices: [{ ...notice, link: "ui://tasks/panel" }] })).toBe(false);
  });

  test("runs pages by an opaque cursor, as list does", () => {
    const input = schema("runs_input");
    expect(input({ cursor: "opaque", limit: 20 })).toBe(true);
    expect(input({ before: "2026-01-01T00:00:00Z" })).toBe(false);
    for (const tool of ["list", "runs"]) {
      const properties = doc.$defs[`${tool}_output`]?.properties as Record<string, unknown>;
      expect(properties.nextCursor).toBeDefined();
      expect(doc.$defs[`${tool}_output`]?.required).toContain("nextCursor");
    }
  });

  test("a schedule is exactly one of its forms, and a cron names its timezone", () => {
    const create = schema("create_input");
    const make = (s: object) => ({ manifest: { name: "Daily", schedule: s }, body: "Go." });
    expect(create(make({ cron: "0 7 * * 1-5", timezone: "Pacific/Honolulu" }))).toBe(true);
    expect(create(make({ cron: "0 7 * * 1-5" }))).toBe(false);
    expect(create(make({ at: "2026-01-01T09:00:00Z" }))).toBe(true);
    expect(create(make({ at: "tomorrow" }))).toBe(false);
    expect(create(make({ intervalMs: 60000 }))).toBe(true);
    expect(create(make({ match: { source: "mail" } }))).toBe(true);
    expect(create(make({ intervalMs: 60000, at: "2026-01-01T09:00:00Z" }))).toBe(false);
    expect(create(make({}))).toBe(false);
  });

  test("a read returns the schedule as one open object", () => {
    const status = schema("status_output");
    const task = { id: "t", name: "T", enabled: true, prompt: "Go." };
    const read = (schedule: object) => status({ task: { ...task, schedule }, recentRuns: [] });
    expect(read({ cron: "0 7 * * *", timezone: "UTC" })).toBe(true);
    expect(read({ intervalMs: 60000, rrule: "FREQ=DAILY" })).toBe(true);
    expect(doc.$defs.status_output && JSON.stringify(doc.$defs.status_output)).not.toContain(
      '"oneOf"',
    );
  });

  test("a public output types a value from a set as a string, so a new value still reads", () => {
    const run = { id: "run_1", taskId: "t", execution: "paused", label: "Paused", startedAt: "a" };
    expect(schema("runs_output")({ runs: [run], nextCursor: null })).toBe(true);
    const enumTyped = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.some(enumTyped);
      if (value === null || typeof value !== "object") return false;
      const node = value as Record<string, unknown>;
      if (node.type === "string" && "enum" in node) return true;
      return Object.values(node).some(enumTyped);
    };
    for (const tool of names((t) => t.visibility === "public")) {
      expect(enumTyped(doc.$defs[`${tool}_output`])).toBe(false);
    }
  });

  test("a public output needs only its core", () => {
    const run = { id: "run_1", taskId: "t", execution: "completed", label: "Succeeded" };
    const ended = { ...run, startedAt: "a", completedAt: "b" };
    const runs = schema("runs_output");
    expect(runs({ runs: [ended], nextCursor: null })).toBe(true);
    expect(runs({ runs: [ended] })).toBe(false);
    expect(runs({ runs: [run], nextCursor: null })).toBe(false);
    const queued = { ...run, execution: "queued", label: "Queued" };
    expect(runs({ runs: [queued], nextCursor: "opaque" })).toBe(true);
    expect(schema("run_output")({ runId: "run_1", taskId: "t" })).toBe(true);
    expect(schema("run_output")({ runId: "run_1" })).toBe(false);
    const task = { id: "t", name: "T", enabled: true, prompt: "Go." };
    expect(schema("create_output")({ task })).toBe(true);
    const counts = Object.fromEntries(
      ["pending", "queued", "running", "pass", "fail", "uncertain"]
        .concat(["not_assessed", "failed", "skipped", "cancelled"])
        .map((k) => [k, 0]),
    );
    const batch = { id: "b", taskId: "t", state: "running", counts };
    expect(schema("batch_output")({ batch })).toBe(true);
  });

  test("no public output carries a grant", () => {
    for (const [tool, entry] of Object.entries(doc.tools)) {
      if (entry.visibility !== "public") continue;
      expect(JSON.stringify(doc.$defs[`${tool}_output`])).not.toContain('"grant"');
    }
  });
});

describe("the files contract document", () => {
  const doc = DOCUMENTS.files;
  const ajv = compiler();
  ajv.compile(doc);
  const schema = (key: string) => {
    const validate = ajv.getSchema(`${doc.$id}#/$defs/${key}`);
    if (!validate) throw new Error(`no $defs entry ${key}`);
    return validate;
  };
  const names = (keep: (t: ToolEntry) => boolean) =>
    Object.entries(doc.tools)
      .filter(([, t]) => keep(t))
      .map(([name]) => name)
      .sort();
  const file = {
    id: "fl_0123456789abcdef01234567",
    filename: "report.pdf",
    mimeType: "application/pdf",
    size: 1024,
    tags: [],
    source: "chat",
    conversationId: null,
    createdAt: "2026-01-01T09:00:00.000Z",
    description: null,
  };
  const uri = `files://${file.id}`;

  test("names the contract and states its own URL", () => {
    expect(doc.contract).toBe("ai.nimblebrain.files");
    expect(doc.$id).toBe("https://schemas.nimblebrain.ai/contracts/files/v1/contract.json");
    expect(doc.version).toBe("1.0");
    expect(doc.cardinality).toBe("singleton");
  });

  test("keeps today's public tool names, with read_pdf_pages folded into read", () => {
    expect(names((t) => t.visibility === "public")).toEqual([
      "create",
      "create_folder",
      "delete",
      "delete_folder",
      "info",
      "list",
      "move",
      "read",
      "search",
      "tag",
      "update_folder",
    ]);
    expect(doc.tools.read_pdf_pages).toBeUndefined();
  });

  test("lets an unattended run reach every public tool, as today, and no private one", () => {
    expect(names((t) => t.visibility === "public" && t.unattended !== "allowed")).toEqual([]);
    expect(names((t) => t.visibility === "private")).toEqual([
      "delete_workspace",
      "record",
      "released",
      "resolve",
    ]);
    expect(names((t) => t.grant === true)).toEqual([]);
  });

  test("every private input carries the host's version and is closed", () => {
    for (const tool of names((t) => t.visibility === "private")) {
      const input = doc.$defs[`${tool}_input`];
      expect((input?.required as string[]) ?? []).toContain("version");
      expect(input?.additionalProperties).toBe(false);
    }
    const ws = schema("delete_workspace_input");
    expect(ws({ version: "1.0" })).toBe(true);
    expect(ws({ version: "2.0" })).toBe(false);
    expect(ws({ version: "1.0", ownerId: "u" })).toBe(false);
  });

  test("record takes a blob key and a door, and answers the URI and the record", () => {
    const input = schema("record_input");
    const call = {
      version: "1.0",
      blob: "b_0123456789abcdef",
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: 1024,
      source: "chat",
      conversationId: "conv_0123456789abcdef",
    };
    expect(input(call)).toBe(true);
    expect(input({ ...call, source: "agent" })).toBe(false);
    expect(input({ ...call, blob: "../etc/passwd" })).toBe(false);
    expect(input({ ...call, blob: "Upper" })).toBe(false);
    expect(input({ ...call, runId: "run_1" })).toBe(true);
    expect(input({ ...call, ownerId: "u" })).toBe(false);
    const output = schema("record_output");
    expect(output({ uri, file })).toBe(true);
    expect(output({ uri: "files://ws_1/x", file })).toBe(false);
    expect(output({ uri, file, blob: "b" })).toBe(false);
  });

  test("resolve answers each URI found, with its blob key, or absent", () => {
    const input = schema("resolve_input");
    expect(input({ version: "1.0", uris: [uri] })).toBe(true);
    expect(input({ version: "1.0", uris: [] })).toBe(false);
    expect(input({ version: "1.0", uris: Array(101).fill(uri) })).toBe(false);
    expect(input({ version: "1.0", uris: ["https://example.com/x"] })).toBe(false);
    const output = schema("resolve_output");
    const found = { uri, found: true, file, blob: "b_1" };
    expect(output({ files: [found, { uri, found: false }] })).toBe(true);
    const { blob: _blob, ...noBlob } = found;
    expect(output({ files: [noBlob] })).toBe(false);
    expect(output({ files: [{ uri, found: false, blob: "b_1" }] })).toBe(false);
  });

  test("released pages keys by a cursor that is null exactly on an empty page", () => {
    const output = schema("released_output");
    expect(output({ blobs: ["b_1"], nextCursor: "c" })).toBe(true);
    expect(output({ blobs: [], nextCursor: null })).toBe(true);
    expect(output({ blobs: ["b_1"] })).toBe(false);
    expect(schema("released_input")({ version: "1.0", cursor: "c", limit: 1000 })).toBe(true);
    expect(schema("released_input")({ version: "1.0", limit: 1001 })).toBe(false);
  });

  test("read takes an optional page list, at most 10, and answers pages beside the record", () => {
    const input = schema("read_input");
    expect(input({ id: file.id })).toBe(true);
    expect(input({ id: file.id, pages: [1, 2] })).toBe(true);
    expect(input({ id: file.id, pages: [] })).toBe(false);
    expect(input({ id: file.id, pages: [0] })).toBe(false);
    expect(input({ id: file.id, pages: Array.from({ length: 11 }, (_, i) => i + 1) })).toBe(false);
    const output = schema("read_output");
    const base = { id: file.id, filename: "r.pdf", mimeType: "application/pdf", size: 1 };
    expect(output({ ...base, extractedText: "hello", truncated: false })).toBe(true);
    const paged = {
      ...base,
      extractedText: null,
      truncated: false,
      totalPages: 3,
      requestedPages: [2, 4],
      missingPages: [4],
      pages: [{ page: 2, text: "two", truncated: false, empty: false }],
    };
    expect(output(paged)).toBe(true);
  });

  test("create keeps today's input shape", () => {
    const create = schema("create_input");
    const manifest = { filename: "notes.md", mimeType: "text/markdown", folder: "Reports/Q3" };
    expect(create({ manifest, body: "# Notes", encoding: "text" })).toBe(true);
    expect(create({ manifest, body: "aGk=" })).toBe(true);
    expect(create({ manifest, body: "x", encoding: "hex" })).toBe(false);
    expect(create({ manifest: { filename: "a" }, body: "x" })).toBe(false);
  });

  test("a folder id is the implementation's, by grammar", () => {
    const move = schema("move_input");
    expect(move({ ids: [file.id], folderId: "root" })).toBe(true);
    expect(move({ ids: [file.id], folderId: "fd_0123456789abcdef01234567" })).toBe(true);
    expect(move({ ids: [file.id], folderId: "folder-1" })).toBe(true);
    expect(move({ ids: [file.id], folderId: "../up" })).toBe(false);
  });

  test("a public output types a record's source as an open string", () => {
    expect(schema("info_output")({ ...file, source: "import" })).toBe(true);
    expect(schema("info_output")({ ...file, source: 1 })).toBe(false);
  });

  test("no public output names a blob key", () => {
    for (const tool of names((t) => t.visibility === "public")) {
      expect(JSON.stringify(doc.$defs[`${tool}_output`])).not.toContain('"blob"');
    }
  });

  test("its public errors are the closed list the spec names", () => {
    expect(doc.errors.public.map((e) => e.code).sort()).toEqual([
      "conflict",
      "extraction_failed",
      "file_not_found",
      "folder_not_found",
      "invalid_input",
      "not_paged",
      "scope_missing",
      "too_large",
      "unknown_tool",
    ]);
    expect(doc.errors.private.map((e) => e.code).sort()).toEqual([
      "forbidden",
      "internal_error",
      "invalid_input",
      "scope_missing",
    ]);
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

  test("accepts an optional runId", () => {
    expect(validate({ principal: "person", unattended: true, runId: "run_1" })).toBe(true);
    expect(validate({ principal: "person", runId: "" })).toBe(false);
  });
});

describe("the emitter", () => {
  const tool = (input: TSchema = Type.Object({}), output: TSchema = Type.Object({})) => ({
    input,
    output,
  });
  const source = (
    tools: ContractSource["meta"]["tools"],
    schemas: ContractSource["schemas"],
    shared: ContractSource["shared"] = {},
  ): ContractSource => ({
    meta: {
      $id: "https://schemas.nimblebrain.ai/contracts/example/v1/contract.json",
      title: "Example",
      description: "A contract made to test the emitter.",
      contract: "ai.nimblebrain.example",
      version: "1.0",
      cardinality: "singleton",
      tools,
      errors: { public: [], private: [] },
    },
    schemas,
    shared,
  });

  test("emits a well-formed source", () => {
    const ok = source(
      {
        save: { visibility: "public", unattended: "refused", grant: true },
        poll: { visibility: "private", unattended: "refused" },
      },
      {
        public: { save: tool() },
        private: { poll: tool(Type.Object({ item: Type.Unsafe({ $ref: "#/$defs/item" }) })) },
      },
      { item: Type.Object({ id: Type.String() }) },
    );
    expect(JSON.parse(emit(ok)).$defs.item).toBeDefined();
  });

  test("refuses a grant on a private tool or on one an unattended run may call", () => {
    const onPrivate = source(
      { poll: { visibility: "private", unattended: "refused", grant: true } },
      { public: {}, private: { poll: tool() } },
    );
    expect(() => emit(onPrivate)).toThrow(/carries a grant/);
    const onAllowed = source(
      { read: { visibility: "public", unattended: "allowed", grant: true } },
      { public: { read: tool() }, private: {} },
    );
    expect(() => emit(onAllowed)).toThrow(/carries a grant/);
  });

  test("refuses a $ref in a public tool's schema", () => {
    const bad = source(
      { read: { visibility: "public", unattended: "allowed" } },
      {
        public: { read: tool(Type.Object({ x: Type.Unsafe({ $ref: "#/$defs/item" }) })) },
        private: {},
      },
      { item: Type.Object({}) },
    );
    expect(() => emit(bad)).toThrow(/holds a \$ref/);
  });

  test("refuses nested $defs in any tool's schema", () => {
    const nested = Type.Unsafe({ type: "object", $defs: { x: { type: "string" } } });
    const bad = source(
      { poll: { visibility: "private", unattended: "refused" } },
      { public: {}, private: { poll: tool(nested) } },
    );
    expect(() => emit(bad)).toThrow(/nests \$defs/);
  });
});
