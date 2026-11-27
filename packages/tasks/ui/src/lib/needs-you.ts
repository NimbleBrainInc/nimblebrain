/**
 * Why a run asks for the person, in one plain sentence, and what to say to the
 * agent about it. A status names its cause and its next step, or it does not
 * ask for attention: every run that reads "Needs you" or "Didn't work" with a
 * cause the record names gets a sentence here, and the screens pair it with
 * the two things that fix it (edit the task's instructions, or ask in chat).
 *
 * The cause comes from the run's recorded failures: each tool its failed calls
 * left failed, with the host's reason (`bad_input`, `tool_error`, `denied`,
 * `timeout`, `unavailable`; CONTRACT.md §8). Pure, so the wording is tested
 * apart from the views.
 */
import type { RunToolCall, TaskRun } from "../types.ts";

/** A tool whose failed calls no later call made good, and why its last one failed. */
export interface ToolFailure {
  name: string;
  errorReason?: string;
}

/**
 * The tasks tools a scheduled run can never call: the contract marks them
 * `unattended: "refused"` (CONTRACT.md §10), by the names agents call them.
 * `needs-you.test.ts` holds this list to the contract document.
 */
export const RUN_REFUSED_TASK_TOOLS: Readonly<Record<string, string>> = {
  tasks__create: "create",
  tasks__update: "edit",
  tasks__delete: "delete",
  tasks__run: "run",
  tasks__run_batch: "run",
  tasks__cancel: "cancel",
  tasks__batch_control: "manage",
};

/**
 * A tool call as a person reads it: `hubspot__search_deals` is "Search deals"
 * in hubspot. The name keeps its source so two tools of the same name stay apart.
 */
export function stepTitle(name: string): { action: string; source?: string } {
  const sep = name.indexOf("__");
  const source = sep > 0 ? name.slice(0, sep) : undefined;
  const raw = (sep > 0 ? name.slice(sep + 2) : name).replace(/[_-]+/g, " ").trim();
  const action = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : name;
  return { action, ...(source ? { source } : {}) };
}

/** A tool by its title in a sentence: "Search deals in hubspot". */
function toolTitle(name: string): string {
  const { action, source } = stepTitle(name);
  return source ? `${action} in ${source}` : action;
}

/** "a", "a and b", "a, b and c". */
function andList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const unique = (items: string[]) => [...new Set(items)];

/** Whether `name` matches an `allowedTools` entry, where `*` is any run of characters. */
function allowedBy(entry: string, name: string): boolean {
  if (!entry.includes("*")) return entry === name;
  const source = entry.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${source}$`).test(name);
}

/**
 * The failures a run left, by tool: the record's own `toolFailures`; else read
 * from the activity log (each failed tool's last failed call, for the tools the
 * record names); else the names alone.
 */
export function failuresOf(run: TaskRun | undefined, log?: RunToolCall[]): ToolFailure[] {
  if (run?.toolFailures?.length) return run.toolFailures;
  const names = run?.unrecoveredToolFailures ?? [];
  return names.map((name) => {
    const last = [...(log ?? [])].reverse().find((c) => c.name === name && !c.ok);
    return last?.errorReason ? { name, errorReason: last.errorReason } : { name };
  });
}

/**
 * The refused calls: tasks tools no run may call, tools outside the task's own
 * list (when it is known), and the rest, refused in scheduled runs.
 */
function deniedPredicates(names: string[], allowedTools?: string[]): string[] {
  const authoring = names.filter((n) => RUN_REFUSED_TASK_TOOLS[n]);
  const rest = names.filter((n) => !RUN_REFUSED_TASK_TOOLS[n]);
  const unlisted = allowedTools?.length
    ? rest.filter((n) => !allowedTools.some((entry) => allowedBy(entry, n)))
    : [];
  const refused = rest.filter((n) => !unlisted.includes(n));
  const out: string[] = [];
  if (authoring.length > 0) {
    const verbs = andList(unique(authoring.map((n) => RUN_REFUSED_TASK_TOOLS[n] ?? n)));
    out.push(`tried to ${verbs} scheduled tasks, which scheduled runs can't do`);
  }
  if (unlisted.length > 0) out.push(`isn't allowed to use ${andList(unlisted.map(toolTitle))}`);
  if (refused.length > 0) {
    const verb = refused.length === 1 ? "isn't" : "aren't";
    out.push(
      `tried to use ${andList(refused.map(toolTitle))}, which ${verb} allowed in scheduled runs`,
    );
  }
  return out;
}

/** What the task did, for one reason's tools: a predicate after "This task". */
function predicate(reason: string, names: string[], allowedTools?: string[]): string[] {
  const titles = andList(names.map(toolTitle));
  const one = names.length === 1;
  switch (reason) {
    case "denied":
      return deniedPredicates(names, allowedTools);
    case "unavailable": {
      const connectors = unique(names.map((n) => stepTitle(n).source ?? toolTitle(n)));
      return [
        `couldn't reach ${andList(connectors)}, which ${connectors.length === 1 ? "isn't" : "aren't"} connected`,
      ];
    }
    case "bad_input":
      return [`called ${titles} with arguments ${one ? "it" : "they"} rejected`];
    case "tool_error":
      return [`got an error back from ${titles}`];
    case "timeout":
      return [`timed out waiting on ${titles}`];
    default:
      return [`had ${titles} fail`];
  }
}

/** One sentence naming each failed tool and why, grouped by reason in the order they first failed. */
export function failureSentence(failures: ToolFailure[], allowedTools?: string[]): string | null {
  if (failures.length === 0) return null;
  const byReason = new Map<string, string[]>();
  for (const f of failures) {
    const reason = f.errorReason ?? "";
    byReason.set(reason, [...(byReason.get(reason) ?? []), f.name]);
  }
  const parts = [...byReason].flatMap(([reason, names]) =>
    predicate(reason, unique(names), allowedTools),
  );
  // Each clause may hold its own "and", so clauses are joined with a comma before the last.
  const joined =
    parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
  return `This task ${joined}.`;
}

/** The limit a run stopped at or was told to wrap up at, in words. */
const LIMIT_TEXT: Record<string, string> = {
  max_iterations: "its step limit",
  max_input_tokens: "its input-token limit",
  spend_limit: "its budget",
  timeout: "its time limit",
  length: "the output length limit",
};

/** Why a run that left no tool failure reads "Needs you": the limit it stopped at, else its error. */
function limitSentence(run: TaskRun, stopReason?: string): string | null {
  const wrapUp = /wrap up at its (\w+) limit/.exec(run.error ?? "")?.[1];
  const limit = LIMIT_TEXT[stopReason ?? ""] ?? LIMIT_TEXT[wrapUp ?? ""];
  if (limit)
    return `This task reached ${limit} before it finished, so part of its work may be undone.`;
  if (run.execution === "incomplete") return "This task stopped before it finished.";
  const first = run.error?.split("\n")[0]?.trim();
  return first ? `This task needs a look: ${first}` : null;
}

/** What the screens know about a run beyond its record. */
export interface AttentionContext {
  /** The run's activity log, when its result was read. */
  log?: RunToolCall[];
  /** The task's `allowedTools`, when its definition was read. */
  allowedTools?: string[];
  /** The run's stop reason, when its result was read. */
  stopReason?: string;
}

/**
 * The sentence a run that asks for the person shows, or null when it does not
 * ask: a run that needs review, a result that did not match its shape, and a
 * failed run whose tool failures say why.
 */
export function attentionOf(run: TaskRun | undefined, ctx: AttentionContext = {}): string | null {
  if (!run) return null;
  if (run.label === "Poor result") return "The output didn't match the expected shape.";
  const failures = failuresOf(run, ctx.log);
  if (run.label === "Needs review") {
    return failureSentence(failures, ctx.allowedTools) ?? limitSentence(run, ctx.stopReason);
  }
  if (run.label === "Failed") return failureSentence(failures, ctx.allowedTools);
  return null;
}

/**
 * What "Ask in chat" sends: the task and the run by id, the failure in words,
 * and the ask, so the agent can read both and propose the change.
 */
export function askMessage(
  task: { id: string; name: string },
  run: { id: string },
  sentence: string,
): string {
  return (
    `My scheduled task "${task.name}" (id ${task.id}) needs me. Its run ${run.id} says: ${sentence}\n\n` +
    "Read the task with tasks__status and the run with tasks__run_result, tell me what to change, " +
    "and make the change with tasks__update once I agree."
  );
}
