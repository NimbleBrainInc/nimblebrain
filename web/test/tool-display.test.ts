import { afterEach, describe, expect, it } from "bun:test";
import type { ToolCallDisplay } from "../src/hooks/useChat";
import { describeBatch, describeCall, registerToolRenderer } from "../src/lib/tool-display";
import { clearRenderersForTest } from "../src/lib/tool-display/registry";
import { dominantVerb, inferVerb, phraseFor } from "../src/lib/tool-display/verbs";

afterEach(() => clearRenderersForTest());

// Minimal factory for the tests; fields default to a successful "done" call.
function call(overrides: Partial<ToolCallDisplay> & { name: string }): ToolCallDisplay {
  return {
    id: overrides.id ?? `call_${Math.random().toString(36).slice(2, 8)}`,
    name: overrides.name,
    status: "done",
    ok: true,
    ms: 10,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe("inferVerb", () => {
  it("maps common prefixes to verbs", () => {
    expect(inferVerb("get_source").verb).toBe("Read");
    expect(inferVerb("read_file").verb).toBe("Read");
    expect(inferVerb("set_source").verb).toBe("Rewrote");
    expect(inferVerb("patch_source").verb).toBe("Edited");
    expect(inferVerb("update_record").verb).toBe("Updated");
    expect(inferVerb("create_document").verb).toBe("Created");
    expect(inferVerb("duplicate_template").verb).toBe("Duplicated");
    expect(inferVerb("delete_record").verb).toBe("Deleted");
    expect(inferVerb("remove_key").verb).toBe("Deleted");
    expect(inferVerb("list_documents").verb).toBe("Listed");
    expect(inferVerb("search_index").verb).toBe("Searched");
    expect(inferVerb("find_user").verb).toBe("Searched");
    expect(inferVerb("query_db").verb).toBe("Searched");
    expect(inferVerb("save_document").verb).toBe("Saved");
    expect(inferVerb("open_document").verb).toBe("Opened");
    expect(inferVerb("load_state").verb).toBe("Opened");
    expect(inferVerb("close_conn").verb).toBe("Closed");
    expect(inferVerb("send_message").verb).toBe("Sent");
    expect(inferVerb("post_webhook").verb).toBe("Sent");
    expect(inferVerb("fetch_feed").verb).toBe("Fetched");
    expect(inferVerb("compile_project").verb).toBe("Built");
    expect(inferVerb("build_bundle").verb).toBe("Built");
    expect(inferVerb("research_topic").verb).toBe("Researched");
    expect(inferVerb("analyze_logs").verb).toBe("Analyzed");
    expect(inferVerb("analyse_logs").verb).toBe("Analyzed"); // UK spelling
    expect(inferVerb("investigate_incident").verb).toBe("Investigated");
    expect(inferVerb("summarize_doc").verb).toBe("Summarized");
    expect(inferVerb("summarise_doc").verb).toBe("Summarized"); // UK spelling
    expect(inferVerb("plan_sprint").verb).toBe("Planned");
    expect(inferVerb("execute_query").verb).toBe("Ran");
  });

  it("falls back to 'Ran' for unknown verbs", () => {
    expect(inferVerb("weirdly_named_tool").verb).toBe("Ran");
    expect(inferVerb("xyz").verb).toBe("Ran");
  });

  it("extracts the noun-like tail as the object", () => {
    expect(inferVerb("patch_source").object).toBe("source");
    expect(inferVerb("search_knowledge_base").object).toBe("knowledge base");
    expect(inferVerb("create_document").object).toBe("document");
    expect(inferVerb("list_documents").object).toBe("documents");
  });

  it("treats unknown single-word names as the object under the default verb", () => {
    expect(inferVerb("ping")).toEqual({ verb: "Ran", object: "ping" });
    expect(inferVerb("bespoke_thing")).toEqual({ verb: "Ran", object: "bespoke thing" });
  });

  it("recognizes bare verb names without an underscore", () => {
    expect(inferVerb("search")).toEqual({ verb: "Searched", object: "" });
    expect(inferVerb("research")).toEqual({ verb: "Researched", object: "" });
    expect(inferVerb("fetch")).toEqual({ verb: "Fetched", object: "" });
  });

  it("finds verb tokens that appear after leading modifiers", () => {
    // start_research — "start" isn't a verb root, so we look deeper
    expect(inferVerb("start_research")).toEqual({ verb: "Researched", object: "" });
    expect(inferVerb("start_research_topic")).toEqual({ verb: "Researched", object: "topic" });
    expect(inferVerb("initiate_search_docs")).toEqual({ verb: "Searched", object: "docs" });
  });

  it("is case-insensitive on verb matching", () => {
    expect(inferVerb("GET_SOURCE").verb).toBe("Read");
    expect(inferVerb("Patch_Source").verb).toBe("Edited");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("dominantVerb", () => {
  it("picks destructive verbs over reads", () => {
    expect(dominantVerb(["Read", "Edited", "Read"])).toBe("Edited");
    expect(dominantVerb(["Read", "Deleted"])).toBe("Deleted");
    expect(dominantVerb(["Opened", "Read"])).toBe("Opened");
  });

  it("prefers Rewrote over Edited (bigger change)", () => {
    expect(dominantVerb(["Edited", "Rewrote"])).toBe("Rewrote");
  });

  it("defaults to 'Ran' on empty input", () => {
    expect(dominantVerb([])).toBe("Ran");
  });

  it("returns the only verb when homogeneous", () => {
    expect(dominantVerb(["Read", "Read", "Read"])).toBe("Read");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("phraseFor", () => {
  it("produces 'Verb the object' for ok tone", () => {
    expect(phraseFor("Edited", "document", "ok")).toBe("Edited the document");
    expect(phraseFor("Searched", "knowledge base", "ok")).toBe("Searched the knowledge base");
  });

  it("produces 'Couldn't verb the object' for error tone", () => {
    expect(phraseFor("Edited", "document", "error")).toBe("Couldn't edit the document");
    expect(phraseFor("Deleted", "record", "error")).toBe("Couldn't delete the record");
  });

  it("drops 'the object' when object is empty", () => {
    expect(phraseFor("Ran", "", "ok")).toBe("Ran");
    expect(phraseFor("Ran", "", "error")).toBe("Couldn't run");
  });

  it("uses present-progressive for running tone", () => {
    expect(phraseFor("Edited", "document", "running")).toBe("Editing the document");
    expect(phraseFor("Researched", "topic", "running")).toBe("Researching the topic");
    expect(phraseFor("Ran", "query", "running")).toBe("Running the query");
    expect(phraseFor("Read", "", "running")).toBe("Reading");
  });

  it("falls back to past tense when present-progressive is unmapped", () => {
    expect(phraseFor("Bespoke", "thing", "running")).toBe("Bespoke the thing");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("describeCall — Tier 0 generic", () => {
  it("strips the server prefix from the name", () => {
    const d = describeCall(call({ name: "collateral__patch_source" }));
    expect(d.name).toBe("patch_source");
    expect(d.verb).toBe("Edited");
  });

  it("propagates status as tone", () => {
    expect(describeCall(call({ name: "get_x", status: "running" })).tone).toBe("running");
    expect(describeCall(call({ name: "get_x", status: "error", ok: false })).tone).toBe("error");
    expect(describeCall(call({ name: "get_x" })).tone).toBe("ok");
  });

  it("flags result.isError as error tone even when status is done", () => {
    const d = describeCall(
      call({
        name: "patch_source",
        result: { content: [{ type: "text", text: "boom" }], isError: true },
      }),
    );
    expect(d.tone).toBe("error");
    expect(d.errorText).toBe("boom");
  });

  it("builds a one-line summary from the highest-priority input key", () => {
    const d = describeCall(
      call({ name: "search_knowledge_base", input: { query: "foo bar", limit: 10 } }),
    );
    expect(d.summary).toBe("query: foo bar");
  });

  it("truncates long summaries", () => {
    const d = describeCall(call({ name: "search_knowledge_base", input: { query: "x".repeat(200) } }));
    expect(d.summary).toContain("…");
    expect(d.summary!.length).toBeLessThanOrEqual(120);
  });

  it("returns null summary for empty input", () => {
    expect(describeCall(call({ name: "list_docs", input: {} })).summary).toBeNull();
    expect(describeCall(call({ name: "list_docs" })).summary).toBeNull();
  });

  it("describes input fields, marking long/multiline values as long", () => {
    const d = describeCall(
      call({
        name: "patch_source",
        input: { find: "small", replace: "y".repeat(200), note: "a\nb" },
      }),
    );
    const byKey = Object.fromEntries(d.input.map((f) => [f.key, f]));
    expect(byKey.find.kind).toBe("short");
    expect(byKey.replace.kind).toBe("long");
    expect(byKey.note.kind).toBe("long");
  });

  it("extracts text from MCP content[0]", () => {
    const d = describeCall(
      call({
        name: "get_source",
        result: { content: [{ type: "text", text: "hello" }], isError: false },
      }),
    );
    expect(d.resultText).toBe("hello");
  });

  it("exposes headSubject: the raw value of the best input key", () => {
    const d = describeCall(
      call({ name: "start_research", input: { topic: "nimblebrain", depth: 3 } }),
    );
    expect(d.headSubject).toBe("nimblebrain");
  });

  it("truncates long headSubject values", () => {
    const d = describeCall(call({ name: "search", input: { query: "x".repeat(200) } }));
    expect(d.headSubject!.endsWith("…")).toBe(true);
    expect(d.headSubject!.length).toBeLessThanOrEqual(41);
  });

  it("returns null headSubject when input is empty or non-string", () => {
    expect(describeCall(call({ name: "get_source" })).headSubject).toBeNull();
    expect(describeCall(call({ name: "get_source", input: {} })).headSubject).toBeNull();
    expect(describeCall(call({ name: "get_source", input: { id: 42 } })).headSubject).toBeNull();
    expect(
      describeCall(call({ name: "get_source", input: { key: "unmapped", other: "x" } }))
        .headSubject,
    ).toBeNull();
  });

  it("returns null resultText when content is missing or non-text", () => {
    expect(describeCall(call({ name: "x_y" })).resultText).toBeNull();
    const d = describeCall(
      call({ name: "x_y", result: { content: [{ type: "image", data: "…" }], isError: false } }),
    );
    expect(d.resultText).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("describeBatch", () => {
  it("returns an empty batch for zero calls", () => {
    const b = describeBatch([]);
    expect(b.items).toEqual([]);
    expect(b.verbPhrase).toBe("");
    expect(b.totalMs).toBeNull();
  });

  it("uses the dominant verb across a mixed batch", () => {
    const b = describeBatch([
      call({ name: "get_source" }),
      call({ name: "patch_source" }),
      call({ name: "get_source" }),
    ]);
    expect(b.verbPhrase).toBe("Edited the source");
    expect(b.tone).toBe("ok");
  });

  it("switches to error phrasing when any call failed", () => {
    const b = describeBatch([
      call({ name: "patch_source" }),
      call({ name: "patch_source", status: "error", ok: false }),
    ]);
    expect(b.tone).toBe("error");
    expect(b.verbPhrase).toBe("Couldn't edit the source");
  });

  it("reports running tone when any call is running, regardless of errors later", () => {
    const b = describeBatch([
      call({ name: "patch_source", status: "error", ok: false }),
      call({ name: "get_source", status: "running" }),
    ]);
    expect(b.tone).toBe("running");
  });

  it("uses present-progressive verb phrasing while running", () => {
    const b = describeBatch([call({ name: "research_topic", status: "running", ms: undefined })]);
    expect(b.tone).toBe("running");
    expect(b.verbPhrase).toBe("Researching the topic");
  });

  it("pairs the dominant verb with the object from the first call using that verb", () => {
    const b = describeBatch([
      call({ name: "get_doc" }),
      call({ name: "patch_source" }),
      call({ name: "patch_config" }),
    ]);
    // Dominant verb is Edited; first Edited call is patch_source → object "source"
    expect(b.verbPhrase).toBe("Edited the source");
  });

  it("sums durations across calls", () => {
    const b = describeBatch([
      call({ name: "a_x", ms: 5 }),
      call({ name: "b_y", ms: 15 }),
    ]);
    expect(b.totalMs).toBe(20);
  });

  it("treats missing durations as zero when others exist", () => {
    const b = describeBatch([call({ name: "a_x", ms: undefined }), call({ name: "b_y", ms: 15 })]);
    expect(b.totalMs).toBe(15);
  });

  it("returns null totalMs when no call has a duration", () => {
    const b = describeBatch([call({ name: "a_x", ms: undefined })]);
    expect(b.totalMs).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ToolRenderer registry", () => {
  it("uses a registered renderer for matching calls", () => {
    registerToolRenderer({
      match: (name) => name === "collateral__patch_source" || name === "patch_source",
      describe: (c) => ({
        id: c.id,
        name: "patch_source",
        verb: "Sculpted",
        object: "document",
        tone: "ok",
        summary: "custom summary",
        headSubject: null,
        input: [],
        resultText: null,
        resultJson: null,
        errorText: null,
        durationMs: null,
      }),
    });
    const d = describeCall(call({ name: "patch_source" }));
    expect(d.verb).toBe("Sculpted");
    expect(d.summary).toBe("custom summary");
  });

  it("falls back to the generic describer when no renderer matches", () => {
    registerToolRenderer({
      match: (name) => name === "something_else",
      describe: () => {
        throw new Error("should not be called");
      },
    });
    const d = describeCall(call({ name: "patch_source" }));
    expect(d.verb).toBe("Edited");
  });

  it("lets later registrations take precedence over earlier ones", () => {
    registerToolRenderer({
      match: () => true,
      describe: (c) => ({
        id: c.id,
        name: "A",
        verb: "A-verb",
        object: "",
        tone: "ok",
        summary: null,
        headSubject: null,
        input: [],
        resultText: null,
        resultJson: null,
        errorText: null,
        durationMs: null,
      }),
    });
    registerToolRenderer({
      match: () => true,
      describe: (c) => ({
        id: c.id,
        name: "B",
        verb: "B-verb",
        object: "",
        tone: "ok",
        summary: null,
        headSubject: null,
        input: [],
        resultText: null,
        resultJson: null,
        errorText: null,
        durationMs: null,
      }),
    });
    const d = describeCall(call({ name: "whatever" }));
    expect(d.verb).toBe("B-verb");
  });
});
