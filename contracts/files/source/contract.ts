/**
 * The files contract's authoring data: everything in the published document
 * except the tools' schemas. `contracts/scripts/emit-contracts.ts` joins it with
 * the schemas (`public.ts` and `private.ts`, gathered in `index.ts`) into
 * `schemas/contracts/files/v1/contract.json`. Nothing at runtime imports this
 * file.
 */

import type { ContractMeta } from "../../scripts/contract-source.ts";

export const CONTRACT = {
  $id: "https://schemas.nimblebrain.ai/contracts/files/v1/contract.json",
  title: "Files contract",
  description:
    "The ai.nimblebrain.files contract: its identity, version, cardinality, its tools with " +
    "their visibility, unattended marking and schemas, and the closed list of errors. Every " +
    "tool error is a tools/call result with isError: true whose first text content is JSON " +
    "{code, error}. A private tool's code is from errors.private. A public tool's code, and the " +
    "answer to a tool name the server does not have, is from errors.public, and its error " +
    "begins with that entry's prefix. Beyond the prefix, error is diagnostic. A request refused " +
    "before any tool runs is the transport's answer and outside this list. Normative rules: " +
    "contracts/files/CONTRACT.md in the NimbleBrain repository.",
  contract: "ai.nimblebrain.files",
  version: "1.0",
  cardinality: "singleton",
  tools: {
    list: { visibility: "public", unattended: "allowed" },
    search: { visibility: "public", unattended: "allowed" },
    info: { visibility: "public", unattended: "allowed" },
    read: { visibility: "public", unattended: "allowed" },
    create: { visibility: "public", unattended: "allowed" },
    tag: { visibility: "public", unattended: "allowed" },
    move: { visibility: "public", unattended: "allowed" },
    delete: { visibility: "public", unattended: "allowed" },
    create_folder: { visibility: "public", unattended: "allowed" },
    update_folder: { visibility: "public", unattended: "allowed" },
    delete_folder: { visibility: "public", unattended: "allowed" },
    record: { visibility: "private", unattended: "refused" },
    resolve: { visibility: "private", unattended: "refused" },
    released: { visibility: "private", unattended: "refused" },
    delete_workspace: { visibility: "private", unattended: "refused" },
  },
  errors: {
    public: [
      {
        code: "file_not_found",
        prefix: "File not found: ",
        meaning:
          "An id names no file in the caller's scope: another owner's, another workspace's, a deleted and a missing one answer alike. For move, any one id; nothing moved.",
      },
      {
        code: "folder_not_found",
        prefix: "Folder not found: ",
        meaning: "A folder id names no folder in the caller's scope. Nothing was written.",
      },
      {
        code: "conflict",
        prefix: "Conflict: ",
        meaning:
          "The call contradicts what is stored: a folder name already taken beside it, a folder moved into itself or a folder inside it, a folder deleted while it holds files or folders. Nothing was written.",
      },
      {
        code: "not_paged",
        prefix: "Not a paged document: ",
        meaning: "read named pages of a file whose type has none (1.0 pages PDFs only).",
      },
      {
        code: "extraction_failed",
        prefix: "Text extraction failed: ",
        meaning:
          "read named pages, and the document's text could not be extracted within the implementation's bounds. A read without pages answers extractedText: null instead.",
      },
      {
        code: "too_large",
        prefix: "Too large: ",
        meaning:
          "create's body, decoded, is over the contract's limit (CONTRACT.md §7). Nothing was written.",
      },
      {
        code: "scope_missing",
        prefix: "[files] no ",
        meaning:
          "tools/call reached a public tool with no workspace or no authenticated identity in its scope.",
      },
      {
        code: "invalid_input",
        prefix: "Invalid arguments for ",
        meaning:
          "The arguments do not match the tool's input schema, or a rule the schema cannot state (a body that is not the base64 its encoding names, a folder path with an empty segment); the tool name follows the prefix, quoted. Nothing was written.",
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
          "A private tool was called by a principal other than host. Checked before the input and the scope, so the answer reveals nothing about either. Nothing was read or written.",
      },
      {
        code: "invalid_input",
        meaning: "The arguments do not match the tool's input schema. Nothing was written.",
      },
      {
        code: "scope_missing",
        meaning:
          "The call reached the server with no workspace in its scope, or record or resolve with no owner. Nothing was read or written.",
      },
      {
        code: "internal_error",
        meaning: "Anything else. The error text is diagnostic only.",
      },
    ],
  },
} as const satisfies ContractMeta;
