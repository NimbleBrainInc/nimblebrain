/**
 * The conversations contract's whole authoring source, as
 * `contracts/scripts/emit-contracts.ts` reads it: the metadata in
 * `contract.ts` and every tool's schemas by visibility. Nothing at runtime
 * imports this file.
 */

import type { ContractSource } from "../../scripts/contract-source.ts";
import { CONTRACT } from "./contract.ts";
import { PRIVATE_SCHEMAS } from "./private.ts";
import * as Public from "./public.ts";

export const SOURCE: ContractSource = {
  meta: CONTRACT,
  schemas: {
    public: {
      list: { input: Public.ConversationsListInput, output: Public.ConversationsListOutput },
      get: { input: Public.ConversationsGetInput, output: Public.ConversationsGetOutput },
      search: { input: Public.ConversationsSearchInput, output: Public.ConversationsSearchOutput },
      update: { input: Public.ConversationsUpdateInput, output: Public.ConversationsUpdateOutput },
      stats: { input: Public.ConversationsStatsInput, output: Public.ConversationsStatsOutput },
      export: { input: Public.ConversationsExportInput, output: Public.ConversationsExportOutput },
    },
    private: PRIVATE_SCHEMAS,
  },
};
