/**
 * The task editor's draft: what the form holds, how it is read from a
 * stored task, and the create / update / inline-run arguments it makes.
 */
import type { ScheduleSpec } from "../components/SchedulePicker.tsx";
import type { OnPoorResult, TaskDetail } from "../types.ts";
import {
  type CriterionDraft,
  draftsValid,
  fromCriteria,
  toCriteria,
  validateDrafts,
} from "./criteria.ts";
import {
  type BuilderField,
  builderProblem,
  fieldsFromSchema,
  schemaFromFields,
} from "./schemaForm.ts";

export type TriggerMode = "manual" | "schedule" | "event";

export interface EventDraft {
  source: string;
  name: string;
  level: "" | "info" | "attention" | "urgent";
  debounceSec: string;
  maxFiresPerHour: string;
}

export interface EditorDraft {
  name: string;
  description: string;
  doMode: "prompt" | "skill";
  prompt: string;
  skill: string;
  inputMode: "builder" | "json";
  inputFields: BuilderField[];
  inputJson: string;
  criteria: CriterionDraft[];
  confidence: string;
  outputJson: string;
  judgeServer: string;
  judgeId: string;
  trigger: TriggerMode;
  schedule: ScheduleSpec | null;
  event: EventDraft;
  enabled: boolean;
  allowedTools: string;
  model: string;
  maxIterations: string;
  maxRunDurationSec: string;
  maxInputTokens: string;
  budgetOn: boolean;
  budgetInput: string;
  budgetOutput: string;
  budgetPeriod: "daily" | "monthly" | "lifetime";
  onPoorResult: "" | OnPoorResult;
}

export function emptyDraft(): EditorDraft {
  return {
    name: "",
    description: "",
    doMode: "prompt",
    prompt: "",
    skill: "",
    inputMode: "builder",
    inputFields: [],
    inputJson: "",
    criteria: [],
    confidence: "",
    outputJson: "",
    judgeServer: "",
    judgeId: "",
    trigger: "manual",
    schedule: null,
    event: { source: "", name: "", level: "", debounceSec: "", maxFiresPerHour: "" },
    enabled: true,
    allowedTools: "",
    model: "",
    maxIterations: "",
    maxRunDurationSec: "",
    maxInputTokens: "",
    budgetOn: false,
    budgetInput: "",
    budgetOutput: "",
    budgetPeriod: "daily",
    onPoorResult: "",
  };
}

const str = (n: number | undefined | null) => (n == null ? "" : String(n));
const json = (v: unknown) => (v === undefined ? "" : JSON.stringify(v, null, 2));

/** The trigger fields of a stored schedule. */
function triggerOf(
  schedule: Record<string, unknown> | undefined,
): Pick<EditorDraft, "trigger" | "schedule" | "event"> {
  if (!schedule) return { trigger: "manual", schedule: null, event: emptyDraft().event };
  if (schedule.type !== "event") {
    return {
      trigger: "schedule",
      schedule: schedule as unknown as ScheduleSpec,
      event: emptyDraft().event,
    };
  }
  const match = (schedule.match ?? {}) as Record<string, string | undefined>;
  return {
    trigger: "event",
    schedule: null,
    event: {
      source: match.source ?? "",
      name: match.name ?? "",
      level: (match.level as EventDraft["level"]) ?? "",
      debounceSec: schedule.debounceMs ? String(Number(schedule.debounceMs) / 1000) : "",
      maxFiresPerHour: str(schedule.maxFiresPerHour as number | undefined),
    },
  };
}

/** The budget fields of a stored token budget. */
function budgetOf(
  b: TaskDetail["tokenBudget"],
): Pick<EditorDraft, "budgetOn" | "budgetInput" | "budgetOutput" | "budgetPeriod"> {
  if (!b) return { budgetOn: false, budgetInput: "", budgetOutput: "", budgetPeriod: "daily" };
  return {
    budgetOn: true,
    budgetInput: str(b.maxInputTokens),
    budgetOutput: str(b.maxOutputTokens),
    budgetPeriod: (b.period as "daily" | "monthly" | undefined) ?? "lifetime",
  };
}

/** The input fields of a stored input schema: the builder when it can hold it, else JSON. */
function inputOf(
  schema: TaskDetail["inputSchema"],
): Pick<EditorDraft, "inputMode" | "inputFields" | "inputJson"> {
  const builder = schema ? fieldsFromSchema(schema) : [];
  return builder
    ? { inputMode: "builder", inputFields: builder, inputJson: json(schema) }
    : { inputMode: "json", inputFields: [], inputJson: json(schema) };
}

/** The draft for a stored task. */
export function draftFromDetail(d: TaskDetail): EditorDraft {
  return {
    ...emptyDraft(),
    ...triggerOf(d.schedule as Record<string, unknown> | undefined),
    ...budgetOf(d.tokenBudget),
    ...inputOf(d.inputSchema),
    name: d.name,
    description: d.description ?? "",
    doMode: d.skill && !d.prompt ? "skill" : "prompt",
    prompt: d.prompt ?? "",
    skill: d.skill ?? "",
    criteria: fromCriteria(d.criteria),
    confidence: str(d.confidenceThreshold),
    outputJson: json(d.outputSchema),
    judgeServer: d.judge?.server ?? "",
    judgeId: d.judge?.id ?? "",
    enabled: d.enabled,
    allowedTools: (d.allowedTools ?? []).join(", "),
    model: d.model ?? "",
    maxIterations: str(d.maxIterations),
    maxRunDurationSec: d.maxRunDurationMs ? String(d.maxRunDurationMs / 1000) : "",
    maxInputTokens: str(d.maxInputTokens),
    onPoorResult: d.onPoorResult ?? "",
  };
}

/** Split the comma-separated tools field into patterns, dropping blanks. */
export function parseToolList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseSchemaText(
  text: string,
  what: string,
  problems: string[],
): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      problems.push(`The ${what} must be a JSON object.`);
      return undefined;
    }
    return v as Record<string, unknown>;
  } catch (err) {
    problems.push(`The ${what} is not valid JSON: ${(err as Error).message}`);
    return undefined;
  }
}

function positive(text: string, what: string, problems: string[], min = 1): number | undefined {
  if (!text.trim()) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n < min) {
    problems.push(`${what} must be a number of at least ${min}.`);
    return undefined;
  }
  return n;
}

/** The definition fields the tools share (create's manifest and an inline run), and what is wrong. */
export interface BuiltDefinition {
  problems: string[];
  body: string;
  skill?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  criteria?: ReturnType<typeof toCriteria>;
  confidenceThreshold?: number;
  judge?: { server?: string; id?: string };
  onPoorResult?: OnPoorResult;
  allowedTools?: string[];
  model?: string;
  maxIterations?: number;
  maxRunDurationMs?: number;
  maxInputTokens?: number;
  tokenBudget?: { maxInputTokens?: number; maxOutputTokens?: number; period?: "daily" | "monthly" };
  schedule?: Record<string, unknown>;
}

function readDoing(d: EditorDraft, out: BuiltDefinition): void {
  out.body = d.prompt.trim();
  if (d.doMode === "prompt") {
    if (!out.body) out.problems.push("Say what the task should do.");
    return;
  }
  if (!d.skill.trim()) out.problems.push("Name the skill to carry out.");
  else out.skill = d.skill.trim();
}

function readSchemas(d: EditorDraft, out: BuiltDefinition): void {
  if (d.inputMode === "json") {
    out.inputSchema = parseSchemaText(d.inputJson, "input schema", out.problems);
  } else {
    const p = builderProblem(d.inputFields);
    if (p) out.problems.push(p);
    else out.inputSchema = schemaFromFields(d.inputFields) ?? undefined;
  }
  out.outputSchema = parseSchemaText(d.outputJson, "output schema", out.problems);
}

function readCriteria(d: EditorDraft, out: BuiltDefinition): void {
  if (d.criteria.length === 0) return;
  const { items, list } = validateDrafts(d.criteria);
  const bad = items.findIndex((e) => e.length > 0);
  out.problems.push(...list);
  if (bad >= 0) out.problems.push(`Criterion ${bad + 1}: ${items[bad]?.[0]}`);
  if (draftsValid(d.criteria)) out.criteria = toCriteria(d.criteria);
}

function readAssessment(d: EditorDraft, out: BuiltDefinition): void {
  readCriteria(d, out);
  if (d.confidence.trim()) {
    const c = Number(d.confidence);
    if (!Number.isFinite(c) || c < 0 || c > 1) out.problems.push("Confidence is between 0 and 1.");
    else out.confidenceThreshold = c;
  }
  const server = d.judgeServer.trim();
  const id = d.judgeId.trim();
  if (server || id) out.judge = { ...(server ? { server } : {}), ...(id ? { id } : {}) };
  if (d.onPoorResult) out.onPoorResult = d.onPoorResult;
}

function readBudget(d: EditorDraft, out: BuiltDefinition): void {
  if (!d.budgetOn) return;
  const maxIn = positive(d.budgetInput, "The input-token budget", out.problems);
  const maxOut = positive(d.budgetOutput, "The output-token budget", out.problems);
  if (maxIn === undefined && maxOut === undefined) {
    out.problems.push("A budget needs an input or an output token limit.");
    return;
  }
  out.tokenBudget = {
    ...(maxIn !== undefined ? { maxInputTokens: maxIn } : {}),
    ...(maxOut !== undefined ? { maxOutputTokens: maxOut } : {}),
    ...(d.budgetPeriod !== "lifetime" ? { period: d.budgetPeriod } : {}),
  };
}

function readLimits(d: EditorDraft, out: BuiltDefinition): void {
  const tools = parseToolList(d.allowedTools);
  if (tools.length > 0) out.allowedTools = tools;
  if (d.model.trim()) out.model = d.model.trim();
  out.maxIterations = positive(d.maxIterations, "Max steps", out.problems);
  const secs = positive(d.maxRunDurationSec, "The time limit", out.problems, 10);
  if (secs !== undefined) out.maxRunDurationMs = Math.round(secs * 1000);
  out.maxInputTokens = positive(d.maxInputTokens, "Input tokens per run", out.problems, 1000);
  readBudget(d, out);
}

function scheduleProblem(s: ScheduleSpec | null): string | null {
  if (!s) return "Pick a schedule, or choose Manual only.";
  if (s.type === "once" && !s.at) return "Pick when it runs.";
  if (s.type === "cron" && !s.expression?.trim()) return "Write the cron expression.";
  return null;
}

function readEvent(e: EventDraft, out: BuiltDefinition): void {
  const match: Record<string, string> = {};
  if (e.source.trim()) match.source = e.source.trim();
  if (e.name.trim()) match.name = e.name.trim();
  if (e.level) match.level = e.level;
  const debounce = positive(e.debounceSec, "The wait before a run", out.problems);
  const fires = positive(e.maxFiresPerHour, "Runs per hour", out.problems);
  if (debounce !== undefined && debounce > 900)
    out.problems.push("The wait is at most 900 seconds.");
  if (fires !== undefined && fires > 60) out.problems.push("At most 60 runs per hour.");
  out.schedule = {
    type: "event",
    match,
    ...(debounce !== undefined ? { debounceMs: Math.round(debounce * 1000) } : {}),
    ...(fires !== undefined ? { maxFiresPerHour: Math.round(fires) } : {}),
  };
}

function readTrigger(d: EditorDraft, out: BuiltDefinition): void {
  if (d.trigger === "event") readEvent(d.event, out);
  if (d.trigger !== "schedule") return;
  const problem = scheduleProblem(d.schedule);
  if (problem) out.problems.push(problem);
  else out.schedule = { ...(d.schedule as ScheduleSpec) };
}

/** Read every field of the draft, collecting what is wrong rather than stopping at the first. */
export function buildDefinition(d: EditorDraft): BuiltDefinition {
  const out: BuiltDefinition = { problems: [], body: "" };
  readDoing(d, out);
  readSchemas(d, out);
  readAssessment(d, out);
  readLimits(d, out);
  readTrigger(d, out);
  return out;
}

const DEFINITION_KEYS = [
  "skill",
  "inputSchema",
  "outputSchema",
  "criteria",
  "confidenceThreshold",
  "judge",
  "onPoorResult",
  "allowedTools",
  "model",
  "maxIterations",
  "maxRunDurationMs",
  "maxInputTokens",
  "tokenBudget",
  "schedule",
] as const;

/** `tasks__create`'s arguments, or the problems that stop it. */
export function createArgs(d: EditorDraft): { args?: Record<string, unknown>; problems: string[] } {
  const def = buildDefinition(d);
  if (!d.name.trim()) def.problems.unshift("Give the task a name.");
  if (def.problems.length > 0) return { problems: def.problems };
  const manifest: Record<string, unknown> = { name: d.name.trim(), enabled: d.enabled };
  if (d.description.trim()) manifest.description = d.description.trim();
  for (const k of DEFINITION_KEYS) if (def[k] !== undefined) manifest[k] = def[k];
  return { args: { manifest, body: def.body }, problems: [] };
}

/**
 * `tasks__update`'s arguments: only what changed from the stored task, `null`
 * for a field cleared. An unchanged form sends no manifest.
 */
export function updateArgs(
  taskId: string,
  original: EditorDraft,
  d: EditorDraft,
): { args?: Record<string, unknown>; problems: string[] } {
  const next = buildDefinition(d);
  if (next.problems.length > 0) return { problems: next.problems };
  const before = buildDefinition(original);
  const manifest: Record<string, unknown> = {};
  for (const k of DEFINITION_KEYS) {
    if (JSON.stringify(before[k]) === JSON.stringify(next[k])) continue;
    manifest[k] = next[k] ?? null;
  }
  if (d.description.trim() !== original.description.trim()) {
    manifest.description = d.description.trim() || null;
  }
  if (d.enabled !== original.enabled) manifest.enabled = d.enabled;
  const args: Record<string, unknown> = { taskId };
  if (Object.keys(manifest).length > 0) args.manifest = manifest;
  if (next.body !== before.body) args.body = next.body;
  return { args, problems: [] };
}

/** The definition fields a test run carries over: create's manifest, without trigger. */
const INLINE_KEYS = DEFINITION_KEYS.filter((k) => k !== "schedule");

/** `tasks__run`'s arguments for a test run of the draft as an inline one-off. */
export function testRunArgs(
  d: EditorDraft,
  input: unknown,
): { args?: Record<string, unknown>; problems: string[] } {
  const def = buildDefinition(d);
  if (def.problems.length > 0) return { problems: def.problems };
  const manifest: Record<string, unknown> = {};
  for (const k of INLINE_KEYS) if (def[k] !== undefined) manifest[k] = def[k];
  // A test run records its verdict only: no inbox item, no retry.
  if (def.criteria || def.outputSchema) manifest.onPoorResult = "record";
  const definition: Record<string, unknown> = {
    ...(def.body ? { body: def.body } : {}),
    ...(Object.keys(manifest).length > 0 ? { manifest } : {}),
  };
  return {
    args: { definition, ...(input !== undefined ? { input } : {}) },
    problems: [],
  };
}
