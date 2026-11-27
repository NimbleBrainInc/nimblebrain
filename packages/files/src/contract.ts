/**
 * The files contract as this plugin serves it: the published document (tools, visibility,
 * unattended marking, annotations, schemas, errors), read once, and each tool's input
 * validator compiled from it. Nothing here restates the document; the descriptions are this
 * server's own words.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  type ContractDocument,
  publicErrorPrefix,
  ToolCallError,
} from "../../server-sdk/src/index.ts";

/** Where the document lives in this repository: the published schema tree. */
const CONTRACT_PATH = resolve(import.meta.dir, "../../../schemas/contracts/files/v1/contract.json");

/** A tool's MCP annotations, as the document states them for a public tool. */
export type Annotations = Record<string, boolean>;

export const CONTRACT = JSON.parse(readFileSync(CONTRACT_PATH, "utf-8")) as ContractDocument & {
  tools: Record<string, { annotations?: Annotations }>;
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(CONTRACT);

const validators = new Map<string, ValidateFunction>();

function validatorOf(ref: string | undefined, what: string): ValidateFunction {
  const cached = validators.get(what);
  if (cached) return cached;
  const validate = ref ? ajv.getSchema(new URL(ref, CONTRACT.$id).href) : undefined;
  if (!validate) throw new Error(`the contract has no schema for ${what}`);
  validators.set(what, validate);
  return validate;
}

/** Check a tool's arguments against its input schema; the error text when they fail. */
export function inputError(tool: string, args: unknown): string | null {
  const validate = validatorOf(CONTRACT.tools[tool]?.input.$ref, `${tool} input`);
  return validate(args) ? null : ajv.errorsText(validate.errors);
}

/** Check a tool's answer against its output schema; the error text when it fails. */
export function outputError(tool: string, value: unknown): string | null {
  const validate = validatorOf(CONTRACT.tools[tool]?.output.$ref, `${tool} output`);
  return validate(value) ? null : ajv.errorsText(validate.errors);
}

/** A public tool's failure: its code, and text beginning with the code's prefix. */
export function publicError(code: string, rest: string): ToolCallError {
  return new ToolCallError(code, `${publicErrorPrefix(CONTRACT, code)}${rest}`);
}

/** A private tool's failure. */
export function privateError(code: string, message: string): ToolCallError {
  return new ToolCallError(code, message);
}

export const fileNotFound = (id: string) => publicError("file_not_found", id);
export const folderNotFound = (id: string) => publicError("folder_not_found", id);
export const conflict = (message: string) => publicError("conflict", message);
export const invalidInput = (tool: string, message: string) =>
  publicError("invalid_input", `"${tool}": ${message}`);

/** Each tool's description in `tools/list`. */
export const DESCRIPTIONS: Record<string, string> = {
  list:
    "List your files: in one folder (with the folders inside it) or across all of them, " +
    "filtered by text, kind, source, conversation, run, creation time, tags, or MIME type, " +
    "sorted, and paged by `nextCursor`. Each file carries its folder path, and the result " +
    "counts matches by kind and source.",
  search:
    "Search your files by keyword: a case-insensitive substring of the filename, description " +
    "or tags. Newest first.",
  info: "One file's record by id: name, type, size, tags, folder and where it came from. No content.",
  read:
    "Read a file's text by id: text, code, JSON, Markdown, CSV, HTML, XML, YAML, PDF, DOCX " +
    "and XLSX, up to `maxBytes`. Pass `pages` (at most 10) to read those pages of a PDF. An " +
    "image or other binary answers its record with `extractedText: null`.",
  create:
    "Create a file. `manifest` is its record (filename, MIME type, optional folder path, tags, " +
    'description); `body` is the content, base64 by default, or verbatim with encoding: "text" ' +
    "(use that for markdown, code or anything you compose yourself). At most 4 MiB.",
  tag: "Add or remove tags on a file; answers its tags after the change.",
  move: 'Move files into a folder, by id; "root" is the top level. Every id must name one of your files, or none moves.',
  delete: "Delete a file by id, with its content.",
  create_folder:
    "Create a folder, at the top level or inside `parentId`. A name must be unique among the folders beside it. To put a new file in a folder by path, pass `manifest.folder` to `create` instead; it creates missing folders.",
  update_folder:
    'Rename a folder (`manifest.name`) or move it (`manifest.parentId`; "root" is the top level). Its files and folders go with it.',
  delete_folder:
    "Delete an empty folder. A folder that holds files or folders is refused; move or delete what is inside first.",
  begin_upload: "Open an upload: answers its id and a short-lived URL to PUT the body to.",
  complete_upload: "Make the file from an upload's stored body: answers its URI and record.",
  resolve:
    "Each URI in the caller's scope: found, with its record and a short-lived download URL, or absent.",
  delete_workspace: "Purge every owner's files, folders, uploads and bytes in the workspace.",
};
