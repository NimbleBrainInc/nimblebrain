/**
 * The files contract's whole authoring source, as
 * `contracts/scripts/emit-contracts.ts` reads it: the metadata in
 * `contract.ts` and every tool's schemas by visibility. No schema is shared
 * between tools by reference. Nothing at runtime imports this file.
 */

import type { ContractSource } from "../../scripts/contract-source.ts";
import { CONTRACT } from "./contract.ts";
import { PRIVATE_SCHEMAS } from "./private.ts";
import { PUBLIC_SCHEMAS } from "./public.ts";

export const SOURCE: ContractSource = {
  meta: CONTRACT,
  schemas: { public: PUBLIC_SCHEMAS, private: PRIVATE_SCHEMAS },
};
