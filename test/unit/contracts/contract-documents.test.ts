import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

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

  test("every tool's $ref names its object schema, which refers only to shared $defs", () => {
    for (const [tool, entry] of Object.entries(doc.tools)) {
      for (const kind of ["input", "output"] as const) {
        expect(entry[kind].$ref).toBe(`#/$defs/${tool}_${kind}`);
        const schema = doc.$defs[`${tool}_${kind}`];
        expect(schema?.type).toBe("object");
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

  test("lets an unattended run read and cancel, and refuses every tool that authors or starts work", () => {
    const pub = (u: string) => names((t) => t.visibility === "public" && t.unattended === u);
    expect(pub("allowed")).toEqual([
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
    expect(pub("refused")).toEqual([
      "batch_control",
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
      "check_runs",
      "delete_workspace",
      "due",
      "end_run",
      "expire",
      "offer_event",
    ]);
  });

  test("the inputs that bound an answer carry the host's version", () => {
    for (const tool of ["due", "begin_run", "offer_event"]) {
      expect((doc.$defs[`${tool}_input`]?.required as string[]) ?? []).toContain("version");
    }
    const due = schema("due_input");
    const at = "2026-01-01T09:00:00.000Z";
    expect(due({ version: "1.0", now: at, until: at })).toBe(true);
    expect(due({ version: "2.0", now: at, until: at })).toBe(false);
    expect(due({ now: at, until: at })).toBe(false);
  });

  test("an occurrence names no owner, and the host reads closed answers", () => {
    const due = schema("due_output");
    expect(due({ occurrences: [{ key: "k", ref: "r" }], nextCursor: null })).toBe(true);
    expect(due({ occurrences: [{ key: "k", ref: "r", ownerId: "u" }], nextCursor: null })).toBe(
      false,
    );
    expect(due({ occurrences: [], nextCursor: null, more: true })).toBe(false);
  });

  test("begin_run answers a skip or an agent work spec carrying its grant", () => {
    const output = schema("begin_run_output");
    expect(output({ decision: "skip", reason: "disabled" })).toBe(true);
    expect(
      output({ decision: "skip", reason: "lost", interrupted: { runId: "run_1", token: 2 } }),
    ).toBe(true);
    const work = { kind: "agent", runId: "run_1", grant: "g", prompt: "Summarize." };
    expect(output({ decision: "run", work })).toBe(true);
    expect(output({ decision: "run", work: { ...work, kind: "call" } })).toBe(false);
    expect(output({ decision: "run", work: { ...work, extra: 1 } })).toBe(false);
    const { grant: _grant, ...withoutGrant } = work;
    expect(output({ decision: "run", work: withoutGrant })).toBe(false);
    const account = { id: "a", unit: "usd", remaining: -1 };
    expect(output({ decision: "run", work: { ...work, spendAccounts: [account] } })).toBe(false);
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

    test("requires an error with error, other and not_started, and with nothing else", () => {
      const error = { code: "interrupted", transient: true };
      for (const stopReason of ["error", "other", "not_started"]) {
        expect(outcome({ ...base, stopReason })).toBe(false);
        expect(outcome({ ...base, stopReason, error })).toBe(true);
      }
      expect(outcome({ ...base, stopReason: "cancelled" })).toBe(true);
      expect(outcome({ ...base, stopReason: "spend_limit", spendStop: "exhausted" })).toBe(true);
    });
  });

  test("end_run takes the outcome by reference and answers closed notices", () => {
    const output = schema("end_run_output");
    const notice = { id: "n1", title: "Run failed", body: "", level: "attention" };
    expect(output({ notices: [notice] })).toBe(true);
    expect(output({ notices: [{ ...notice, link: "ui://tasks/panel" }] })).toBe(false);
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

  test("a public output needs only its core", () => {
    const run = { id: "run_1", taskId: "t", execution: "completed", label: "Succeeded" };
    const ended = { ...run, startedAt: "a", completedAt: "b" };
    const runs = schema("runs_output");
    expect(runs({ runs: [ended] })).toBe(true);
    expect(runs({ runs: [run] })).toBe(false);
    expect(runs({ runs: [{ ...run, execution: "queued", label: "Queued" }] })).toBe(true);
    expect(schema("run_output")({ runId: "run_1", taskId: "t", execution: "queued" })).toBe(true);
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
