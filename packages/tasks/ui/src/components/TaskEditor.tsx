import { useEffect, useId, useMemo, useRef, useState } from "react";
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
import type { TaskDetail } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, toolErrorText } from "../utils.ts";
import { PageHeader } from "./Chrome.tsx";
import { InputEditor, type InputState } from "./InputEditor.tsx";
import { InputFieldsBuilder } from "./InputFieldsBuilder.tsx";
import { ResultBody, useOpenFile, useRunResult } from "./ResultView.tsx";
import { runStartedOf } from "./RunDialog.tsx";
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

/** A name made from the first words of the prompt, for a new task whose name nobody typed. */
export function nameFromPrompt(prompt: string): string {
  const words = prompt
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  if (words.length === 0) return "";
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What it should do, in the person's words, and the name it is listed under. */
function WhatToDo({
  d,
  set,
  editing,
  onNameTyped,
}: {
  d: EditorDraft;
  set: Patch;
  editing: boolean;
  onNameTyped: () => void;
}) {
  const id = useId();
  return (
    <Section title="What should it do?">
      <div className="field">
        <label className="sr-only" htmlFor={`${id}-prompt`}>
          {d.doMode === "skill" ? "Instructions for the skill (optional)" : "What it should do"}
        </label>
        <textarea
          id={`${id}-prompt`}
          className="inline-edit-textarea"
          rows={5}
          value={d.prompt}
          placeholder="Summarize my unread email: who wrote, what they ask, and anything due today. Post it in #team on Slack."
          onChange={(e) => set({ prompt: e.target.value })}
        />
        <div className="hint">
          Write it the way you'd ask in chat, including where the result should go.
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-name`}>
          Name
        </label>
        <input
          id={`${id}-name`}
          className="inline-edit-input"
          value={d.name}
          disabled={editing}
          placeholder="Morning email digest"
          onChange={(e) => {
            onNameTyped();
            set({ name: e.target.value });
          }}
        />
        {editing && <div className="hint">A name can't change once it's saved.</div>}
      </div>
    </Section>
  );
}

/** The rarer parts of what it does: a description, skills, and input for each run. */
function Instructions({ d, set }: { d: EditorDraft; set: Patch }) {
  const id = useId();
  return (
    <Section title="Instructions">
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
            {m === "prompt" ? "Follow the text above" : "Follow a skill"}
          </label>
        ))}
      </div>
      {d.doMode === "skill" && (
        <div className="field">
          <label className="field-label" htmlFor={`${id}-skill`}>
            Skills
          </label>
          <input
            id={`${id}-skill`}
            className="inline-edit-input"
            value={d.skill}
            placeholder="skill name (separate several with commas)"
            onChange={(e) => set({ skill: e.target.value })}
          />
          <div className="hint">The text above becomes extra instructions for the skill.</div>
        </div>
      )}
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

function WhatGoodLooksLike({ d, set }: { d: EditorDraft; set: Patch }) {
  const id = useId();
  return (
    <Section
      title="What good looks like"
      hint="Each run's result is checked against the output schema, and the run reads Succeeded or Poor result."
    >
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
    </Section>
  );
}

function When({ d, set }: { d: EditorDraft; set: Patch }) {
  const id = useId();
  const modes = [
    { value: "schedule", text: "On a schedule" },
    { value: "event", text: "When something happens" },
    { value: "manual", text: "Only when I run it" },
  ] as const;
  return (
    <Section title="When should it run?">
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
        <p className="hint">Nothing runs it on its own. Run it from here or ask for it in chat.</p>
      )}
      {d.trigger === "schedule" && (
        <SchedulePicker
          simple
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
          On (untick to save it paused)
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
    </Section>
  );
}

/** A test run's result inline, and its output's shape offered as the output schema. */
function TestRunResult({
  runId,
  onInfer,
}: {
  runId: string;
  onInfer: (schema: Record<string, unknown>) => void;
}) {
  const state = useRunResult(runId);
  const openFile = useOpenFile();
  const value =
    state.result?.structured !== undefined
      ? state.result.structured
      : state.result
        ? parseJsonOutput(state.result.output)
        : undefined;
  return (
    <div className="test-result">
      <ResultBody state={state} onOpenFile={openFile} />
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
  // Most of these run on a clock, so a blank one starts on a daily schedule.
  if (!template)
    return { ...d, trigger: "schedule", schedule: { type: "cron", expression: "0 9 * * *" } };
  return {
    ...d,
    name: template.name || nameFromPrompt(template.prompt),
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

/** The stored task, when editing. */
function useEditorData(taskId: string | undefined) {
  const statusTool = useTool<string>("status");
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) return;
    statusTool
      .call({ taskId, limit: 0 })
      .then((res) => {
        const d = asDict(res.data).task as TaskDetail | undefined;
        if (!d) throw new Error(`No task with id "${taskId}".`);
        setDetail(d);
      })
      .catch((err) => setLoadError(toolErrorText(err)));
  }, [taskId, statusTool]);
  return { detail, loadError };
}

/** A run that takes no input. */
const NO_INPUT: InputState = { ok: true, input: undefined };

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
  const [entered, setInput] = useState<InputState>(NO_INPUT);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const schema = draftInputSchema(draft);
  // What the input form last reported holds only while the form is shown.
  const input = schema ? entered : NO_INPUT;

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
      setTest(started.runId);
      requestAnimationFrame(() => ref.current?.scrollIntoView({ block: "start" }));
    } catch (err) {
      setError(toolErrorText(err, "The test run did not start."));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div ref={ref}>
      <Section
        title="Try it once"
        hint="Runs it once as written, before you save, and shows the result here."
      >
        {/* Input is asked for only when the task takes some (More options). */}
        {schema && <InputEditor key={JSON.stringify(schema)} schema={schema} onChange={setInput} />}
        <button type="button" className="btn" disabled={testing || !input.ok} onClick={run}>
          {testing ? "Starting…" : test ? "Try it again" : "Try it now"}
        </button>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {test && (
          <TestRunResult
            key={test}
            runId={test}
            onInfer={(schema) => set({ outputJson: JSON.stringify(schema, null, 2) })}
          />
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

/**
 * Whether the draft sets anything under More options, so an edit of a task
 * that uses them opens with them showing.
 */
export function hasAdvanced(d: EditorDraft): boolean {
  return (
    d.doMode === "skill" ||
    !!d.description.trim() ||
    d.inputFields.length > 0 ||
    !!d.inputJson.trim() ||
    !!d.outputJson.trim() ||
    !!d.allowedTools.trim() ||
    !!d.model.trim() ||
    !!d.maxIterations.trim() ||
    !!d.maxRunDurationSec.trim() ||
    !!d.maxInputTokens.trim() ||
    d.budgetOn
  );
}

/** The editor's form once there is a draft: every section, the test run, and saving. */
function EditorForm({
  original,
  detail,
  template,
  copy,
  title,
  onSaved,
  onCancel,
}: {
  /** The stored task's draft; null when creating. */
  original: EditorDraft | null;
  detail: TaskDetail | null;
  template?: Template | null;
  /** A draft to start a new task from (Duplicate). */
  copy?: EditorDraft | null;
  title: string;
  onSaved: (task: { id: string; name: string }) => void;
  onCancel: () => void;
}) {
  const createTool = useTool<string>("create");
  const updateTool = useTool<string>("update");
  const [draft, setDraft] = useState<EditorDraft>(() => original ?? copy ?? initialDraft(template));
  const [problems, setProblems] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = !!original;
  // A new task's name follows its prompt until someone types one.
  const [nameTyped, setNameTyped] = useState(() => editing || !!copy || !!template?.name);
  // Opens with the form when the task already uses something in it; after
  // that it is the person's to open and close.
  const [advancedOpen] = useState(() => hasAdvanced(draft));

  const set: Patch = (patch) => {
    setDraft((d) => {
      const next = { ...d, ...patch };
      if (!nameTyped && patch.prompt !== undefined) next.name = nameFromPrompt(next.prompt);
      return next;
    });
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
      onSaved({ id: task.id, name: task.name });
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
              {saving ? "Saving…" : editing ? "Save changes" : "Save"}
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
          <WhatToDo d={draft} set={set} editing={editing} onNameTyped={() => setNameTyped(true)} />
          <When d={draft} set={set} />
          <TestRunSection draft={draft} set={set} onProblems={setProblems} />
          <details className="disclosure more-options" open={advancedOpen}>
            <summary>
              <span className="disclosure-title">More options</span>
              <span className="disclosure-hint">
                Skills, input, checks on the result, tools, model and limits
              </span>
            </summary>
            <div className="disclosure-body">
              <Sections>
                <Instructions d={draft} set={set} />
                <WhatGoodLooksLike d={draft} set={set} />
                <Limits d={draft} set={set} />
              </Sections>
            </div>
          </details>
        </Sections>
      </div>
    </div>
  );
}

/**
 * Create or edit a scheduled task: what it should do and when, a try of the
 * draft before it is saved, and every other setting under More options.
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
  onSaved: (task: { id: string; name: string }) => void;
  onCancel: () => void;
}) {
  const source = taskId ?? copyOf;
  const { detail, loadError } = useEditorData(source);
  const loaded = useMemo(() => (detail ? draftFromDetail(detail) : null), [detail]);
  const original = taskId ? loaded : null;
  const copy = copyOf && loaded ? { ...loaded, name: `${loaded.name} (copy)` } : null;
  const title = taskId ? `Edit ${detail?.name ?? ""}`.trim() : "New scheduled task";
  if (source && !detail) {
    return <EditorLoading title={title} error={loadError} onBack={onCancel} />;
  }
  return (
    <EditorForm
      original={original}
      copy={copy}
      detail={taskId ? detail : null}
      template={template}
      title={title}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}
