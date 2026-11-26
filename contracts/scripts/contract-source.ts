/**
 * The shape every contract's authoring source takes: what `emit-contracts.ts`
 * reads from `contracts/<name>/source/index.ts` to write one published
 * document. Nothing at runtime imports this file.
 */

import type { TSchema } from "@sinclair/typebox";

/** Who may call a tool: either principal (`public`) or only the host (`private`). */
export type Visibility = "public" | "private";

/**
 * Whether a call made inside an unattended run (a call whose host context
 * carries `unattended: true`) may reach the tool. A private tool is never
 * offered to a run, so it is always `refused`.
 */
export type Unattended = "allowed" | "refused";

export interface ContractError {
  code: string;
  /** A public error's `error` begins with this text. */
  prefix?: string;
  meaning: string;
}

/** One tool's entry in the document, less its schemas. */
export interface ContractToolEntry {
  visibility: Visibility;
  unattended: Unattended;
}

/** Everything a contract document holds except its schemas. */
export interface ContractMeta {
  /** Where the document is served. Stated, never derived from `contract`. */
  $id: string;
  title: string;
  description: string;
  /** The contract's identity, the name a plugin's `implements[].contract` uses. */
  contract: string;
  version: string;
  cardinality: "singleton" | "additive";
  /**
   * Whether the host stamps a run grant into the host context of every
   * `person` call to an implementation (`contracts/host-context/CONTEXT.md`).
   */
  grants: boolean;
  tools: Readonly<Record<string, ContractToolEntry>>;
  errors: Readonly<Record<Visibility, readonly ContractError[]>>;
}

export type ToolSchemas = Record<string, { input: TSchema; output: TSchema }>;

/** A contract's whole authoring source: its metadata and each tool's schemas, by visibility. */
export interface ContractSource {
  meta: ContractMeta;
  schemas: Record<Visibility, ToolSchemas>;
}
