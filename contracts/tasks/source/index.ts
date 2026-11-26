/**
 * The tasks contract's whole authoring source, as
 * `contracts/scripts/emit-contracts.ts` reads it: the metadata in
 * `contract.ts`, every tool's schemas by visibility, and the schemas tools
 * share. Nothing at runtime
 * imports this file.
 */

import type { ContractSource } from "../../scripts/contract-source.ts";
import { CONTRACT } from "./contract.ts";
import { PRIVATE_SCHEMAS, SHARED } from "./private.ts";
import { PUBLIC_SCHEMAS } from "./public.ts";

export const SOURCE: ContractSource = {
  meta: CONTRACT,
  schemas: { public: PUBLIC_SCHEMAS, private: PRIVATE_SCHEMAS },
  shared: SHARED,
};
