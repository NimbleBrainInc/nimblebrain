import { useEffect, useId, useMemo, useRef, useState } from "react";
import { draftFromVerdict } from "../lib/criteria.ts";
import {
  createArgs,
  draftFromDetail,
  type EditorDraft,
  emptyDraft,
  testRunArgs,
  updateArgs,
} from "../lib/editorDraft.ts";
import { inferSchema, parseJsonOutput } from "../lib/inferSchema.ts";
import { builderProblem, fieldsFromSchema, schemaFromFields } from "../lib/schemaForm.ts";
import type { JudgesData, TaskDetail, TaskRun, TaskWarning } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, toolErrorText } from "../utils.ts";
import { PageHeader } from "./Chrome.tsx";
import { CriteriaEditor } from "./CriteriaEditor.tsx";
import { InputEditor, type InputState } from "./InputEditor.tsx";
import { InputFieldsBuilder } from "./InputFieldsBuilder.tsx";
import { ResultBody, useAssess, useOpenFile, useRunResult } from "./ResultView.tsx";
import { type RunStarted, runStartedOf } from "./RunDialog.tsx";
import { SchedulePicker } from "./SchedulePicker.tsx";
import { Section as Card, Sections } from "./Section.tsx";
import type { Template } from "./templates.ts";

export { parseToolList } from "../lib/editorDraft.ts";

type Patch = (patch: Partial<EditorDraft>) => void;

/** One editor group: a section card, with its hint first. */
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Card title={title}>
      {hint && <p className="hint card-hint">{hint}</p>}
      {children}
    </Card>
  );
}

function WhatToDo({ d, set, editing }: { d: EditorDraft; set: Patch; editing: boolean }) {
  const id = useId();
  return (
    <Section title="What to do">
      <div className="field">
        <label className="field-label" htmlFor={`${id}-name`}>
          Name
        </label>
        <input
          id={`${id}-name`}
          className="inline-edit-input"
          value={d.name}
          disabled={editing}
          placeholder="Weekly pipeline review"
          onChange={(e) => set({ name: e.target.value })}
        />
        {editing && <div className="hint">A task keeps its name; its id is made from it.</div>}
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-desc`}>
          Description (optional)
        </label>
        <input
          id={`${id}-desc`}
          className="inline-edit-input"
          value={d.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </div>
      <div className="segmented" role="radiogroup" aria-label="How it is told what to do">
        {(["prompt", "skill"] as const).map((m) => (
          <label key={m} className={`seg${d.doMode === m ? " on" : ""}`}>
            <input
              type="radio"
              name={`${id}-do`}
              checked={d.doMode === m}
              onChange={() => set({ doMode: m })}
            />
            {m === "prompt" ? "A prompt" : "A skill"}
          </label>
        ))}
      </div>
      {d.doMode === "skill" && (
        <div className="field">
          <label className="field-label" htmlFor={`${id}-skill`}>
            Skill
          </label>
          <input
            id={`${id}-skill`}
            className="inline-edit-input"
            value={d.skill}
            placeholder="skill name"
            onChange={(e) => set({ skill: e.target.value })}
          />
        </div>
      )}
      <div className="field">
        <label className="field-label" htmlFor={`${id}-prompt`}>
          {d.doMode === "skill" ? "Instructions for the skill (optional)" : "Prompt"}
        </label>
        <textarea
          id={`${id}-prompt`}
          className="inline-edit-textarea"
          rows={5}
          value={d.prompt}
          placeholder="Summarize the week's activity, key decisions, and open items."
          onChange={(e) => set({ prompt: e.target.value })}
        />
      </div>
      <h3 className="sub-heading">Input for each run</h3>
      {d.inputMode === "builder" ? (
        <>
          <InputFieldsBuilder
            rows={d.inputFields}
            onChange={(rows) => set({ inputFields: rows })}
          />
          <button type="button" className="link-btn" onClick={() => set({ inputMode: "json" })}>
            Write the input schema as JSON
          </button>
        </>
      ) : (
        <div className="field">
          <label className="field-label" htmlFor={`${id}-ischema`}>
            Input schema (JSON Schema)
          </label>
          <textarea
            id={`${id}-ischema`}
            className="inline-edit-textarea code"
            rows={6}
            spellCheck={false}
            value={d.inputJson}
            placeholder='{ "type": "object", "properties": { "company": { "type": "string" } } }'
            onChange={(e) => set({ inputJson: e.target.value })}
          />
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              let rows: ReturnType<typeof fieldsFromSchema> = [];
              try {
                rows = d.inputJson.trim() ? fieldsFromSchema(JSON.parse(d.inputJson)) : [];
              } catch {
                rows = null;
              }
              if (rows) set({ inputMode: "builder", inputFields: rows });
            }}
          >
            Use the field builder
          </button>
          <div className="hint">The builder holds flat objects of text, numbers and yes/no.</div>
        </div>
      )}
    </Section>
  );
}

function WhatGoodLooksLike({
  d,
  set,
  judges,
}: {
  d: EditorDraft;
  set: Patch;
  judges: JudgesData | null;
}) {
  const id = useId();
  const named = d.judgeServer.trim();
  const showWarning =
    d.criteria.length > 0 && judges?.warning && !(named && judges.servers.includes(named));
  return (
    <Section
      title="What good looks like"
      hint="After each run, a connected judge checks the result against these rules, and the run reads Succeeded, Poor result, or Needs review."
    >
      <CriteriaEditor drafts={d.criteria} onChange={(criteria) => set({ criteria })} />
      {showWarning && (
        <div className="note-banner" role="status">
          {judges?.warning?.message}
        </div>
      )}
      <div className="field">
        <label className="field-label" htmlFor={`${id}-oschema`}>
          Output schema (optional JSON Schema)
        </label>
        <textarea
          id={`${id}-oschema`}
          className="inline-edit-textarea code"
          rows={5}
          spellCheck={false}
          value={d.outputJson}
          onChange={(e) => set({ outputJson: e.target.value })}
          placeholder={'{ "type": "object", "properties": { "grade": { "type": "string" } } }'}
        />
        <div className="hint">
          The run answers with JSON matching it, and its result shows as values and tables.
        </div>
      </div>
      <details className="disclosure advanced">
        <summary>
          <span className="disclosure-title">Advanced</span>
          <span className="disclosure-hint">Which judge, and how sure it must be</span>
        </summary>
        <div className="disclosure-body">
          <div className="field-row">
            <div className="field">
              <label className="field-label" htmlFor={`${id}-judge`}>
                Judge
              </label>
              <select
                id={`${id}-judge`}
                className="inline-edit-input"
                value={named}
                onChange={(e) => set({ judgeServer: e.target.value })}
              >
                <option value="">
                  {judges?.servers.length === 1
                    ? `The connected judge (${judges.servers[0]})`
                    : "The connected judge"}
                </option>
                {(judges?.servers ?? []).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
                {named && !judges?.servers.includes(named) && (
                  <option value={named}>{named}</option>
                )}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${id}-jid`}>
                Judge id (optional)
              </label>
              <input
                id={`${id}-jid`}
                className="inline-edit-input"
                value={d.judgeId}
                placeholder="its default"
                onChange={(e) => set({ judgeId: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${id}-conf`}>
                Confidence needed
              </label>
              <input
                id={`${id}-conf`}
                className="inline-edit-input"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={d.confidence}
                placeholder="0.7"
                onChange={(e) => set({ confidence: e.target.value })}
              />
            </div>
          </div>
        </div>
      </details>
    </Section>
  );
}

function When({ d, set }: { d: EditorDraft; set: Patch }) {
  const id = useId();
  const modes = [
    { value: "manual", text: "Manual only" },
    { value: "schedule", text: "On a schedule" },
    { value: "event", text: "On an event" },
  ] as const;
  return (
    <Section title="When it runs">
      <div className="segmented" role="radiogroup" aria-label="When it runs">
        {modes.map((m) => (
          <label key={m.value} className={`seg${d.trigger === m.value ? " on" : ""}`}>
            <input
              type="radio"
              name={`${id}-when`}
              checked={d.trigger === m.value}
              onChange={() =>
                set({
                  trigger: m.value,
                  ...(m.value === "schedule" && !d.schedule
                    ? { schedule: { type: "interval", intervalMs: 3_600_000 } }
                    : {}),
                })
              }
            />
            {m.text}
          </label>
        ))}
      </div>
      {d.trigger === "manual" && (
        <p className="hint">
          Nothing runs it on its own: run it from Saved, from chat, or remotely.
        </p>
      )}
      {d.trigger === "schedule" && (
        <SchedulePicker
          value={d.schedule}
          onChange={(schedule) =>
            set(schedule ? { schedule } : { trigger: "manual", schedule: null })
          }
        />
      )}
      {d.trigger === "event" && (
        <>
          <p className="hint">
            Runs when a notification arrives that a workspace admin routed to this task. These
            fields narrow which ones; they do not open a route.
          </p>
          <div className="field-row">
            <div className="field">
              <label className="field-label" htmlFor={`${id}-src`}>
                From connector
              </label>
              <input
                id={`${id}-src`}
                className="inline-edit-input"
                value={d.event.source}
                placeholder="any"
                onChange={(e) => set({ event: { ...d.event, source: e.target.value } })}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${id}-ename`}>
                Event name
              </label>
              <input
                id={`${id}-ename`}
                className="inline-edit-input"
                value={d.event.name}
                placeholder="e.g. mail.*"
                onChange={(e) => set({ event: { ...d.event, name: e.target.value } })}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${id}-lvl`}>
                At least
              </label>
              <select
                id={`${id}-lvl`}
                className="inline-edit-input"
                value={d.event.level}
                onChange={(e) =>
                  set({
                    event: { ...d.event, level: e.target.value as EditorDraft["event"]["level"] },
                  })
                }
              >
                <option value="">Any level</option>
                <option value="info">Info</option>
                <option value="attention">Attention</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label className="field-label" htmlFor={`${id}-deb`}>
                Gather events for (seconds)
              </label>
              <input
                id={`${id}-deb`}
                className="inline-edit-input"
                type="number"
                min={1}
                max={900}
                value={d.event.debounceSec}
                placeholder="30"
                onChange={(e) => set({ event: { ...d.event, debounceSec: e.target.value } })}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${id}-mf`}>
                At most, runs per hour
              </label>
              <input
                id={`${id}-mf`}
                className="inline-edit-input"
                type="number"
                min={1}
                max={60}
                value={d.event.maxFiresPerHour}
                placeholder="12"
                onChange={(e) => set({ event: { ...d.event, maxFiresPerHour: e.target.value } })}
              />
            </div>
          </div>
        </>
      )}
      {d.trigger !== "manual" && (
        <label className="check">
          <input
            type="checkbox"
            checked={d.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          Trigger on (untick to save it paused)
        </label>
      )}
    </Section>
  );
}

function Limits({ d, set }: { d: EditorDraft; set: Patch }) {
  const id = useId();
  return (
    <Section title="Limits">
      <div className="field">
        <label className="field-label" htmlFor={`${id}-tools`}>
          Allowed tools
        </label>
        <input
          id={`${id}-tools`}
          className="inline-edit-input"
          value={d.allowedTools}
          placeholder="All tools"
          onChange={(e) => set({ allowedTools: e.target.value })}
        />
        <div className="hint">
          Comma-separated names or globs, e.g. <code>gmail__*</code>, <code>files__read</code> (a
          personal connection is <code>my_gmail__*</code>). Runs can use nothing else apart from{" "}
          <code>nb__search</code> and <code>nb__manage_tools</code>.
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label className="field-label" htmlFor={`${id}-model`}>
            Model
          </label>
          <input
            id={`${id}-model`}
            className="inline-edit-input"
            value={d.model}
            placeholder="workspace default"
            onChange={(e) => set({ model: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${id}-iter`}>
            Max steps per run
          </label>
          <input
            id={`${id}-iter`}
            className="inline-edit-input"
            type="number"
            min={1}
            max={50}
            value={d.maxIterations}
            placeholder="25"
            onChange={(e) => set({ maxIterations: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${id}-dur`}>
            Time limit (seconds)
          </label>
          <input
            id={`${id}-dur`}
            className="inline-edit-input"
            type="number"
            min={10}
            max={600}
            value={d.maxRunDurationSec}
            placeholder="120"
            onChange={(e) => set({ maxRunDurationSec: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${id}-mit`}>
            Input tokens per run
          </label>
          <input
            id={`${id}-mit`}
            className="inline-edit-input"
            type="number"
            min={1000}
            value={d.maxInputTokens}
            placeholder="No cap"
            onChange={(e) => set({ maxInputTokens: e.target.value })}
          />
        </div>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={d.budgetOn}
          onChange={(e) => set({ budgetOn: e.target.checked })}
        />
        Token budget across runs
      </label>
      {d.budgetOn && (
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor={`${id}-bin`}>
              Input tokens
            </label>
            <input
              id={`${id}-bin`}
              className="inline-edit-input"
              type="number"
              min={1}
              value={d.budgetInput}
              onChange={(e) => set({ budgetInput: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-bout`}>
              Output tokens
            </label>
            <input
              id={`${id}-bout`}
              className="inline-edit-input"
              type="number"
              min={1}
              value={d.budgetOutput}
              onChange={(e) => set({ budgetOutput: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-bper`}>
              Resets
            </label>
            <select
              id={`${id}-bper`}
              className="inline-edit-input"
              value={d.budgetPeriod}
              onChange={(e) => set({ budgetPeriod: e.target.value as EditorDraft["budgetPeriod"] })}
            >
              <option value="daily">Daily</option>
              <option value="monthly">Monthly</option>
              <option value="lifetime">Never</option>
            </select>
          </div>
        </div>
      )}
      <div className="field">
        <label className="field-label" htmlFor={`${id}-poor`}>
          When a result is judged poor
        </label>
        <select
          id={`${id}-poor`}
          className="inline-edit-input"
          value={d.onPoorResult}
          onChange={(e) => set({ onPoorResult: e.target.value as EditorDraft["onPoorResult"] })}
        >
          <option value="">Notify (default)</option>
          <option value="record">Record it only</option>
          <option value="retry_once">Retry once with the failed rules as guidance</option>
        </select>
      </div>
    </Section>
  );
}

/** A test run's result inline, with Accept / Reject to seed a criterion from the note. */
function TestRunResult({
  started,
  onSeed,
  onInfer,
}: {
  started: { runId: string; taskId: string; run?: TaskRun };
  onSeed: (verdict: "pass" | "fail", note: string) => void;
  onInfer: (schema: Record<string, unknown>) => void;
}) {
  const state = useRunResult(started.runId, started.taskId, started.run);
  const assess = useAssess(started.runId, started.taskId, state.setRun);
  const openFile = useOpenFile();
  const value =
    state.result?.structured !== undefined
      ? state.result.structured
      : state.result
        ? parseJsonOutput(state.result.output)
        : undefined;
  return (
    <div className="test-result">
      <ResultBody
        state={state}
        canAct
        assessBusy={assess.busy}
        assessError={assess.error}
        onVerdict={async (verdict, note) => {
          if ((await assess.verdict(verdict, note)) && note.trim()) onSeed(verdict, note);
        }}
        onRejudge={() => void assess.rejudge()}
        onOpenFile={openFile}
      />
      {value !== undefined && value !== null && typeof value === "object" && (
        <button type="button" className="btn" onClick={() => onInfer(inferSchema(value))}>
          Use this output's shape as the output schema
        </button>
      )}
    </div>
  );
}

/** The draft a new task starts from: empty, or a template's prompt and schedule. */
function initialDraft(template: Template | null | undefined): EditorDraft {
  const d = emptyDraft();
  if (!template || template.id === "custom") return d;
  return {
    ...d,
    name: template.name,
    prompt: template.prompt,
    trigger: template.schedule ? "schedule" : "manual",
    schedule: template.schedule,
  };
}

/** The input schema the draft describes as it stands, for the test run's input form. */
function draftInputSchema(d: EditorDraft): Record<string, unknown> | undefined {
  if (d.inputMode === "builder") {
    return builderProblem(d.inputFields)
      ? undefined
      : (schemaFromFields(d.inputFields) ?? undefined);
  }
  try {
    const v: unknown = d.inputJson.trim() ? JSON.parse(d.inputJson) : undefined;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The stored task (when editing) and the connected judges. */
function useEditorData(taskId: string | undefined) {
  const statusTool = useTool<string>("status");
  const judgesTool = useTool<string>("judges");
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [judges, setJudges] = useState<JudgesData | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tool calls are stable
  useEffect(() => {
    judgesTool
      .call({})
      .then((res) => setJudges(asDict(res.data) as unknown as JudgesData))
      .catch(() => setJudges({ servers: [] }));
    if (!taskId) return;
    statusTool
      .call({ taskId, limit: 0 })
      .then((res) => {
        const d = asDict(res.data).task as TaskDetail | undefined;
        if (!d) throw new Error(`No task with id "${taskId}".`);
        setDetail(d);
      })
      .catch((err) => setLoadError(toolErrorText(err)));
  }, [taskId]);
  return { detail, loadError, judges };
}

interface TestStarted {
  runId: string;
  taskId: string;
  run?: TaskRun;
  note?: string;
}

/** Where a test run went, from `tasks__run`'s answer. */
function testStartedOf(started: RunStarted): TestStarted {
  return started.kind === "finished"
    ? { runId: started.run.id, taskId: started.run.taskId, run: started.run }
    : { runId: started.runId, taskId: started.taskId, note: started.note };
}

/** The test run: its input, the button, and the result inline. */
function TestRunSection({
  draft,
  set,
  onProblems,
}: {
  draft: EditorDraft;
  set: Patch;
  onProblems: (problems: string[]) => void;
}) {
  const runTool = useTool<string>("run");
  const ref = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState<InputState>({ ok: true, input: undefined });
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestStarted | null>(null);
  const schema = draftInputSchema(draft);

  async function run() {
    if (!input.ok) return;
    const built = testRunArgs(draft, input.input);
    if (!built.args) {
      onProblems(built.problems);
      return;
    }
    setTesting(true);
    setError(null);
    setTest(null);
    try {
      const res = await runTool.call(built.args);
      const started = runStartedOf(asDict(res.data));
      if (!started) throw new Error("The test run did not start.");
      setTest(testStartedOf(started));
      requestAnimationFrame(() => ref.current?.scrollIntoView({ block: "start" }));
    } catch (err) {
      setError(toolErrorText(err, "The test run did not start."));
    } finally {
      setTesting(false);
    }
  }

  const seed = (verdict: "pass" | "fail", note: string) =>
    set({
      criteria: [
        ...draft.criteria,
        draftFromVerdict(
          verdict,
          note,
          draft.criteria.map((c) => c.id),
        ),
      ],
    });

  return (
    <div ref={ref}>
      <Section
        title="Test run"
        hint="Runs the draft once as it stands, before you save, and shows the result here. It is kept with every run as a one-off."
      >
        <InputEditor key={JSON.stringify(schema ?? null)} schema={schema} onChange={setInput} />
        <button type="button" className="btn" disabled={testing || !input.ok} onClick={run}>
          {testing ? "Starting…" : test ? "Run the test again" : "Run a test"}
        </button>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {test?.note && <p className="hint">{test.note}</p>}
        {test && (
          <>
            <TestRunResult
              key={test.runId}
              started={test}
              onSeed={seed}
              onInfer={(schema) => set({ outputJson: JSON.stringify(schema, null, 2) })}
            />
            <p className="hint">
              Accept or reject with a note and the note becomes a draft criterion above, ready to
              edit.
            </p>
          </>
        )}
      </Section>
    </div>
  );
}

/** The editor while the stored task loads, or why it could not. */
function EditorLoading({
  title,
  error,
  onBack,
}: {
  title: string;
  error: string | null;
  onBack: () => void;
}) {
  return (
    <div className="app">
      <PageHeader title={title} onBack={onBack} />
      <div className="content">
        {error ? (
          <div className="error-banner" role="alert">
            {error}
          </div>
        ) : (
          <div className="loading-list" aria-busy="true">
            <div className="skel skel-card" />
            <div className="skel skel-card" />
          </div>
        )}
      </div>
    </div>
  );
}

/** What stops a save, and the save's own error, under the header. */
function EditorProblems({ problems, error }: { problems: string[]; error: string | null }) {
  if (problems.length === 0 && !error) return null;
  return (
    <div className="editor-problems" role="alert">
      {problems.length > 0 && (
        <ul className="problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {error && <div className="error-banner">{error}</div>}
    </div>
  );
}

/** The editor's form once there is a draft: every section, the test run, and saving. */
function EditorForm({
  original,
  detail,
  judges,
  template,
  copy,
  title,
  onSaved,
  onCancel,
}: {
  /** The stored task's draft; null when creating. */
  original: EditorDraft | null;
  detail: TaskDetail | null;
  judges: JudgesData | null;
  template?: Template | null;
  /** A draft to start a new task from (Duplicate). */
  copy?: EditorDraft | null;
  title: string;
  onSaved: (task: { id: string; name: string }, warnings: TaskWarning[]) => void;
  onCancel: () => void;
}) {
  const createTool = useTool<string>("create");
  const updateTool = useTool<string>("update");
  const [draft, setDraft] = useState<EditorDraft>(() => original ?? copy ?? initialDraft(template));
  const [problems, setProblems] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = !!original;

  const set: Patch = (patch) => {
    setDraft((d) => ({ ...d, ...patch }));
    setProblems([]);
  };

  async function save() {
    const built = original && detail ? updateArgs(detail.id, original, draft) : createArgs(draft);
    if (!built.args) {
      setProblems(built.problems);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await (original ? updateTool : createTool).call(built.args);
      const data = asDict(res.data);
      const task = data.task as { id: string; name: string };
      onSaved({ id: task.id, name: task.name }, (data.warnings as TaskWarning[]) ?? []);
    } catch (err) {
      setSaveError(toolErrorText(err, "The task was not saved."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="app">
      <PageHeader
        title={title}
        onBack={onCancel}
        actions={
          <>
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
              {saving ? "Saving…" : editing ? "Save changes" : "Create task"}
            </button>
          </>
        }
      />
      <EditorProblems problems={problems} error={saveError} />
      <div className="content page-body editor">
        {detail?.kind === "oneoff" && (
          <div className="note-banner">This is a one-off task made by an inline run.</div>
        )}
        <Sections>
          <WhatToDo d={draft} set={set} editing={editing} />
          <WhatGoodLooksLike d={draft} set={set} judges={judges} />
          <When d={draft} set={set} />
          <Limits d={draft} set={set} />
          <TestRunSection draft={draft} set={set} onProblems={setProblems} />
        </Sections>
      </div>
    </div>
  );
}

/**
 * Create or edit a task: what to do, what good looks like, when it runs,
 * its limits, and a test run of the draft before it is saved.
 */
export function TaskEditor({
  taskId,
  copyOf,
  template,
  onSaved,
  onCancel,
}: {
  /** The task to edit; absent to create one. */
  taskId?: string;
  /** The id of a task to start a new one from. */
  copyOf?: string;
  template?: Template | null;
  onSaved: (task: { id: string; name: string }, warnings: TaskWarning[]) => void;
  onCancel: () => void;
}) {
  const source = taskId ?? copyOf;
  const { detail, loadError, judges } = useEditorData(source);
  const loaded = useMemo(() => (detail ? draftFromDetail(detail) : null), [detail]);
  const original = taskId ? loaded : null;
  const copy = copyOf && loaded ? { ...loaded, name: `${loaded.name} (copy)` } : null;
  const title = taskId ? `Edit ${detail?.name ?? ""}`.trim() : "New task";
  if (source && !detail) {
    return <EditorLoading title={title} error={loadError} onBack={onCancel} />;
  }
  return (
    <EditorForm
      original={original}
      copy={copy}
      detail={taskId ? detail : null}
      judges={judges}
      template={template}
      title={title}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}
