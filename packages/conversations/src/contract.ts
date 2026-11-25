/**
 * The conversations contract as this plugin serves it: the published document (tools,
 * visibility, schemas, errors), read once, and each tool's input validator compiled from
 * it. Nothing here restates the document; the descriptions are this server's own words.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import type { ContractDocument } from "../../server-sdk/src/index.ts";

/** Where the document lives in this repository: the published schema tree. */
const CONTRACT_PATH = resolve(
  import.meta.dir,
  "../../../schemas/contracts/conversations/v1/contract.json",
);

export const CONTRACT = JSON.parse(readFileSync(CONTRACT_PATH, "utf-8")) as ContractDocument;

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(CONTRACT);

const validators = new Map<string, ValidateFunction>();

/** Check a tool's arguments against its input schema; the error text when they fail. */
export function inputError(tool: string, args: unknown): string | null {
  let validate = validators.get(tool);
  if (!validate) {
    const ref = CONTRACT.tools[tool]?.input.$ref;
    validate = ref ? ajv.getSchema(new URL(ref, CONTRACT.$id).href) : undefined;
    if (!validate) throw new Error(`the contract has no input schema for "${tool}"`);
    validators.set(tool, validate);
  }
  return validate(args) ? null : ajv.errorsText(validate.errors);
}

/** Each tool's description in `tools/list`. */
export const DESCRIPTIONS: Record<string, string> = {
  list: "List conversations in the current workspace, with pagination, sorting, and filtering. Returns conversation metadata (title, timestamps, token counts, preview, and whether a reply is still generating as `active`). Scoped to the workspace you are in — there is no cross-workspace listing, and no workspace argument to pass.",
  get: 'Load a conversation by ID — omit `id` for the conversation you are in. Returns metadata plus, by default, the most recent ~20 messages (with the message payload capped to ~30 KB; the full pretty-printed response stays under ~50 KB). Use expand:"metadata" for just the metadata or expand:"full" when you actually need the entire transcript — long conversations can run hundreds of thousands of tokens and full reads are recorded in tool history.',
  search:
    "Full-text search across message content in the current workspace's conversations. Returns matching conversations with context snippets around each match. Scoped to the workspace you are in — it does not reach other workspaces.",
  update: "Update a conversation's title. Omit `id` to retitle the conversation you are in.",
  stats:
    "Token usage analytics for the current workspace. Returns total tokens, breakdown by model and skill, and top tools used.",
  export:
    "Export a conversation as markdown or JSON — omit `id` for the conversation you are in. Markdown renders messages as a readable document; JSON returns raw JSONL content as a JSON array.",
  create_workspace:
    "Hold the caller's workspace, so conversations can be created in it until delete_workspace releases it. Idempotent: answers whether it was not held before.",
  create: "Create a conversation in the caller's scope. Refuses a taken id (conversation_exists).",
  events:
    "One page of events in seq order, after `afterSeq` and up to `throughSeq` (the snapshot bound; every page returns the conversation's last seq as `lastSeq`).",
  append_events: "Append events in order, all or none; returns the last one's seq.",
  delete: "Delete a conversation and its events.",
  delete_workspace:
    "Remove every owner's conversations in the caller's workspace (the scope's owner is ignored) and release the workspace. Idempotent. Returns what it removed.",
};
