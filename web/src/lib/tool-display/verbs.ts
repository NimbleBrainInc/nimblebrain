import type { Tone } from "./types.ts";

/**
 * Verb inference from tool names.
 *
 * Approach: tokenize the (server-prefix-stripped) tool name on `_`, then
 * pick the FIRST token that matches a known verb root. This handles three
 * shapes uniformly:
 *
 *   "search"              → verb "Searched",   object ""         (bare)
 *   "get_source"          → verb "Read",       object "source"   (verb-first)
 *   "start_research_topic"→ verb "Researched", object "topic"    (prefixed)
 *
 * The `object` is every token after the matched verb, humanized. Tokens
 * before the verb (e.g. "start" in "start_research") are discarded as
 * leading modifiers — they encode "how" the verb runs, not "what".
 *
 * Three tenses per verb:
 *   past tense    "Edited"        — completed (ok tone)
 *   present tense "Editing"       — in flight (running tone)
 *   error form    "Couldn't edit" — failed    (error tone)
 *
 * Past tense is the canonical identifier — it's what inferVerb returns, what
 * dominance compares, and what custom renderers set. Present and error forms
 * are produced by phraseFor based on tone.
 *
 * Batch dominance: when a turn mixes multiple verbs, the batch verb is the
 * one that signals the biggest change. "Edited" wins over "Read"; "Deleted"
 * wins over everything. Reflects how a user would describe what happened —
 * they'd say "I edited the doc" not "I read the doc" even if read came first.
 */

/**
 * Verb roots → past-tense canonical verb.
 *
 * A root matches a single name token (lowercased), not a regex. Add new tools
 * by extending this map plus PRESENT_TENSE and ERROR_VERBS. Keep entries
 * short and unambiguous — a root should be meaningful on its own, not a
 * fragment like "do" or "start" that adds no semantic signal.
 */
const VERB_ROOTS: Readonly<Record<string, string>> = {
  get: "Read",
  read: "Read",
  fetch: "Fetched",
  set: "Rewrote",
  replace: "Rewrote",
  patch: "Edited",
  edit: "Edited",
  update: "Updated",
  modify: "Updated",
  create: "Created",
  add: "Created",
  insert: "Created",
  duplicate: "Duplicated",
  copy: "Duplicated",
  delete: "Deleted",
  remove: "Deleted",
  list: "Listed",
  search: "Searched",
  find: "Searched",
  query: "Searched",
  lookup: "Searched",
  save: "Saved",
  open: "Opened",
  load: "Opened",
  close: "Closed",
  send: "Sent",
  post: "Sent",
  publish: "Sent",
  compile: "Built",
  build: "Built",
  research: "Researched",
  analyze: "Analyzed",
  analyse: "Analyzed",
  investigate: "Investigated",
  summarize: "Summarized",
  summarise: "Summarized",
  plan: "Planned",
  deploy: "Deployed",
  run: "Ran",
  execute: "Ran",
};

/** Returned when no token matches. */
const DEFAULT_VERB = "Ran";

/**
 * Verb dominance ranking — lower index = more dominant. When a batch contains
 * multiple verbs, the batch verb is the one with the smallest index.
 */
const VERB_DOMINANCE: ReadonlyArray<string> = [
  "Deleted",
  "Rewrote",
  "Created",
  "Duplicated",
  "Deployed",
  "Sent",
  "Edited",
  "Updated",
  "Built",
  "Saved",
  "Closed",
  "Planned",
  "Researched",
  "Investigated",
  "Analyzed",
  "Summarized",
  "Searched",
  "Listed",
  "Opened",
  "Fetched",
  "Read",
  "Ran",
];

/**
 * Present-progressive form keyed by past-tense verb. Used when tone is
 * "running". Every verb in VERB_ROOTS (and DEFAULT_VERB) must have an entry
 * here — contributors, update this table when adding a verb root.
 */
const PRESENT_TENSE: Readonly<Record<string, string>> = {
  Read: "Reading",
  Rewrote: "Rewriting",
  Edited: "Editing",
  Updated: "Updating",
  Created: "Creating",
  Duplicated: "Duplicating",
  Deleted: "Deleting",
  Listed: "Listing",
  Searched: "Searching",
  Saved: "Saving",
  Opened: "Opening",
  Closed: "Closing",
  Sent: "Sending",
  Fetched: "Fetching",
  Built: "Building",
  Researched: "Researching",
  Analyzed: "Analyzing",
  Investigated: "Investigating",
  Summarized: "Summarizing",
  Planned: "Planning",
  Deployed: "Deploying",
  Ran: "Running",
};

/** "Couldn't X" phrasing for error tone. Keyed by past-tense verb. */
const ERROR_VERBS: Readonly<Record<string, string>> = {
  Read: "Couldn't read",
  Rewrote: "Couldn't rewrite",
  Edited: "Couldn't edit",
  Updated: "Couldn't update",
  Created: "Couldn't create",
  Duplicated: "Couldn't duplicate",
  Deleted: "Couldn't delete",
  Listed: "Couldn't list",
  Searched: "Couldn't search",
  Saved: "Couldn't save",
  Opened: "Couldn't open",
  Closed: "Couldn't close",
  Sent: "Couldn't send",
  Fetched: "Couldn't fetch",
  Built: "Couldn't build",
  Researched: "Couldn't research",
  Analyzed: "Couldn't analyze",
  Investigated: "Couldn't investigate",
  Summarized: "Couldn't summarize",
  Planned: "Couldn't plan",
  Deployed: "Couldn't deploy",
  Ran: "Couldn't run",
};

/**
 * Infer verb + object from a tool name.
 * @param toolName — already stripped of server prefix.
 */
export function inferVerb(toolName: string): { verb: string; object: string } {
  const tokens = tokenize(toolName);
  for (let i = 0; i < tokens.length; i++) {
    const verb = VERB_ROOTS[tokens[i]];
    if (verb) {
      const object = tokens.slice(i + 1).join(" ");
      return { verb, object };
    }
  }
  // No verb token matched: treat the entire name as the object.
  return { verb: DEFAULT_VERB, object: tokens.join(" ") };
}

/** Pick the most dominant verb from a set. Falls back to `Ran`. */
export function dominantVerb(verbs: ReadonlyArray<string>): string {
  if (verbs.length === 0) return DEFAULT_VERB;
  let best = verbs[0];
  let bestRank = rankOf(best);
  for (let i = 1; i < verbs.length; i++) {
    const r = rankOf(verbs[i]);
    if (r < bestRank) {
      bestRank = r;
      best = verbs[i];
    }
  }
  return best;
}

function rankOf(verb: string): number {
  const idx = VERB_DOMINANCE.indexOf(verb);
  return idx === -1 ? VERB_DOMINANCE.length : idx;
}

/** Split a tool name into lowercase tokens on `_`. Empty segments are dropped. */
function tokenize(toolName: string): string[] {
  return toolName
    .toLowerCase()
    .split("_")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Format a verb + object as a prose phrase, picking the tense from the tone.
 *
 *   ok       → past tense               "Edited the document"
 *   running  → present progressive      "Editing the document"
 *   error    → "Couldn't" construction  "Couldn't edit the document"
 */
export function phraseFor(verb: string, object: string, tone: Tone): string {
  const headword = headwordFor(verb, tone);
  if (!object) return headword;
  return `${headword} the ${object}`;
}

function headwordFor(verb: string, tone: Tone): string {
  if (tone === "error") {
    return ERROR_VERBS[verb] ?? `Couldn't ${verb.toLowerCase()}`;
  }
  if (tone === "running") {
    return PRESENT_TENSE[verb] ?? verb;
  }
  return verb;
}
