/**
 * The conversations contract's authoring data: everything in the published
 * document except the tools' schemas. `scripts/emit-contract.ts` joins it with
 * the schemas (`private.ts` here, and the public tools' source beside today's
 * tools) into `schemas/contracts/conversations/v1/contract.json`. Nothing at
 * runtime imports this file.
 */

export type Visibility = "public" | "private";

export interface ContractError {
  code: string;
  /** A public error's `error` begins with this text, the text models already read. */
  prefix?: string;
  meaning: string;
}

export const CONTRACT = {
  /** Where the document is served. Stated, never derived from `contract`. */
  $id: "https://schemas.nimblebrain.ai/contracts/conversations/v1/contract.json",
  title: "Conversations contract",
  description:
    "The ai.nimblebrain.conversations contract: its identity, version, cardinality, tools " +
    "with their visibility and schemas, and the closed list of errors. Every tool error is a " +
    "tools/call result with isError: true whose first text content is JSON {code, error}. A " +
    "private tool's code is from errors.private. A public tool's code, and the answer to a tool " +
    "name the server does not have, is from errors.public, and its error begins with that " +
    "entry's prefix. Beyond the prefix, error is diagnostic. A request refused before any tool " +
    "runs is the transport's answer and outside this list.",
  /** The contract's identity, the name a plugin's `implements[].contract` uses. */
  contract: "ai.nimblebrain.conversations",
  version: "1.1",
  cardinality: "singleton",
  tools: {
    list: { visibility: "public" },
    get: { visibility: "public" },
    search: { visibility: "public" },
    update: { visibility: "public" },
    stats: { visibility: "public" },
    export: { visibility: "public" },
    create_workspace: { visibility: "private" },
    create: { visibility: "private" },
    events: { visibility: "private" },
    append_events: { visibility: "private" },
    delete: { visibility: "private" },
    delete_workspace: { visibility: "private" },
  } satisfies Record<string, { visibility: Visibility }>,
  errors: {
    public: [
      {
        code: "conversation_not_found",
        prefix: "Conversation not found: ",
        meaning:
          "get, update or export named a conversation outside the caller's scope or absent; the id named follows the prefix.",
      },
      {
        code: "no_current_conversation",
        prefix: "No conversation in scope.",
        meaning: 'id was omitted, or "current", on a call made outside a chat.',
      },
      {
        code: "scope_missing",
        prefix: "[conversations] no ",
        meaning:
          "tools/call reached a public tool with no workspace or no authenticated identity in its scope.",
      },
      {
        code: "invalid_input",
        prefix: "Invalid arguments for ",
        meaning:
          "The arguments do not match the tool's input schema; the tool name follows the prefix, quoted. Nothing was written.",
      },
      {
        code: "unknown_tool",
        prefix: "Unknown tool ",
        meaning: "No tool by that name, public or private.",
      },
    ],
    private: [
      {
        code: "forbidden",
        meaning:
          "A private tool was called by a principal other than host (a person, directly or through an agent, or a call that names no principal). Checked before the input and the scope, so the answer reveals nothing about either. Nothing was read or written.",
      },
      {
        code: "invalid_input",
        meaning: "The arguments do not match the tool's input schema. Nothing was written.",
      },
      {
        code: "scope_missing",
        meaning:
          "The call reached the server with no workspace or no owner in its scope. Nothing was read or written.",
      },
      {
        code: "conversation_not_found",
        meaning:
          "append_events named a conversation absent from the caller's scope: another owner's, another workspace's and a missing one answer alike. Nothing was written. events answers an empty page instead, and delete answers false.",
      },
      {
        code: "conversation_exists",
        meaning: "create named an id already stored in the caller's scope. Nothing was written.",
      },
      {
        code: "workspace_not_found",
        meaning:
          "create in a workspace the implementation does not hold: never held by create_workspace, or released by delete_workspace. Nothing was written.",
      },
      {
        code: "conversation_corrupted",
        meaning: "The stored conversation cannot be read.",
      },
      {
        code: "internal_error",
        meaning: "Anything else. The error text is diagnostic only.",
      },
    ],
  } satisfies Record<Visibility, ContractError[]>,
} as const;
