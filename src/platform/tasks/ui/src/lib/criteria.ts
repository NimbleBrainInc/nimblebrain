/**
 * The editor's criteria list: drafts as the form holds them, the checks the
 * runtime will apply (so the form says what is wrong before a save is
 * refused), and the conversion to and from stored criteria.
 */
import type { TaskCriterion } from "../types.ts";

export type CriterionType = TaskCriterion["type"];

/** One criterion as the form edits it. Lists are one entry per line. */
export interface CriterionDraft {
  id: string;
  rule: string;
  type: CriterionType;
  /** score: the levels, lowest first, one per line. */
  levels: string;
  /** choice: the options, one per line. */
  options: string;
  /** boolean: whether `true` passes. */
  passTrue: boolean;
  /** score: the lowest passing level index; "" for the runtime's default (upper half). */
  passLevel: number | "";
  /** choice: the passing options. */
  passOptions: string[];
}

export const CRITERION_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const MAX_CRITERIA = 50;
const MAX_RULE = 4000;

export function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function emptyDraft(id = ""): CriterionDraft {
  return {
    id,
    rule: "",
    type: "boolean",
    levels: "",
    options: "",
    passTrue: true,
    passLevel: "",
    passOptions: [],
  };
}

/** An id for a rule: its first words, slugged, unique among `taken`. */
export function idFromRule(rule: string, taken: readonly string[]): string {
  const base =
    rule
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 4)
      .join("-")
      .slice(0, 48) || "criterion";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

function scoreErrors(d: CriterionDraft): string[] {
  const errs: string[] = [];
  const levels = lines(d.levels);
  if (levels.length < 2 || levels.length > 10) errs.push("A score needs 2 to 10 levels.");
  else if (new Set(levels).size !== levels.length) errs.push("Levels must differ.");
  if (d.passLevel !== "" && (d.passLevel < 0 || d.passLevel >= levels.length)) {
    errs.push("The passing level is not one of the levels.");
  }
  return errs;
}

function choiceErrors(d: CriterionDraft): string[] {
  const errs: string[] = [];
  const options = lines(d.options);
  if (options.length < 2 || options.length > 255) errs.push("A choice needs 2 to 255 options.");
  else if (new Set(options).size !== options.length) errs.push("Options must differ.");
  if (!d.passOptions.some((o) => options.includes(o))) {
    errs.push("Pick the option or options that pass.");
  }
  return errs;
}

/** What is wrong with one draft; `idCount` is how many drafts share its id. */
function draftErrors(d: CriterionDraft, idCount: number): string[] {
  const errs: string[] = [];
  if (!CRITERION_ID_RE.test(d.id)) errs.push("Id: letters, digits, dot, dash or underscore.");
  else if (idCount > 1) errs.push(`Another criterion has the id "${d.id}".`);
  if (!d.rule.trim()) errs.push("Write the rule.");
  else if (d.rule.length > MAX_RULE) errs.push(`The rule is over ${MAX_RULE} characters.`);
  if (d.type === "score") errs.push(...scoreErrors(d));
  if (d.type === "choice") errs.push(...choiceErrors(d));
  return errs;
}

/** What is wrong with each draft (one list per draft, empty when fine), and with the list. */
export function validateDrafts(drafts: CriterionDraft[]): { items: string[][]; list: string[] } {
  const list: string[] = [];
  if (drafts.length > MAX_CRITERIA) list.push(`At most ${MAX_CRITERIA} criteria.`);
  const counts = new Map<string, number>();
  for (const d of drafts) counts.set(d.id, (counts.get(d.id) ?? 0) + 1);
  return { items: drafts.map((d) => draftErrors(d, counts.get(d.id) ?? 0)), list };
}

/** Whether every draft and the list are valid. */
export function draftsValid(drafts: CriterionDraft[]): boolean {
  const { items, list } = validateDrafts(drafts);
  return list.length === 0 && items.every((e) => e.length === 0);
}

/** The stored criteria the drafts make. Call only on valid drafts. */
export function toCriteria(drafts: CriterionDraft[]): TaskCriterion[] {
  return drafts.map((d) => {
    const c: TaskCriterion = { id: d.id, rule: d.rule.trim(), type: d.type };
    if (d.type === "boolean") {
      if (!d.passTrue) c.pass = false;
    } else if (d.type === "score") {
      c.levels = lines(d.levels);
      if (d.passLevel !== "") c.pass = d.passLevel;
    } else {
      const options = lines(d.options);
      c.options = options;
      const passing = d.passOptions.filter((o) => options.includes(o));
      c.pass = passing.length === 1 ? (passing[0] as string) : passing;
    }
    return c;
  });
}

/** The passing options a stored choice criterion names. */
function passingOptions(pass: TaskCriterion["pass"]): string[] {
  if (Array.isArray(pass)) return pass;
  return typeof pass === "string" ? [pass] : [];
}

/** The draft for one stored criterion. */
function draftOf(c: TaskCriterion): CriterionDraft {
  const d = { ...emptyDraft(c.id), rule: c.rule, type: c.type };
  if (c.type === "boolean") d.passTrue = c.pass !== false;
  if (c.type === "score") {
    d.levels = (c.levels ?? []).join("\n");
    d.passLevel = typeof c.pass === "number" ? c.pass : "";
  }
  if (c.type === "choice") {
    d.options = (c.options ?? []).join("\n");
    d.passOptions = passingOptions(c.pass);
  }
  return d;
}

/** Drafts for stored criteria. */
export function fromCriteria(criteria: TaskCriterion[] | undefined): CriterionDraft[] {
  return (criteria ?? []).map(draftOf);
}

/**
 * A boolean criterion seeded from a person's verdict on a test run: their
 * note becomes the rule to keep (accepted) or the problem to rule out
 * (rejected). The author edits it into a rule before saving.
 */
export function draftFromVerdict(
  verdict: "pass" | "fail",
  note: string,
  taken: readonly string[],
): CriterionDraft {
  const text = note.trim();
  const rule = verdict === "pass" ? text : `The deliverable does not have this problem: ${text}`;
  const d = emptyDraft(idFromRule(text, taken));
  d.rule = rule;
  return d;
}
