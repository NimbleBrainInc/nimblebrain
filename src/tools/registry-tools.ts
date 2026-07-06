import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { ORG_ADMIN_ROLES } from "../identity/types.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { InProcessTool } from "./in-process-app.ts";

/**
 * `manage_registries` tool — admin surface for the connector
 * registry config. The registry list itself is readable by any
 * signed-in user (so the Browse page can display source attributions
 * and the workspace UI can name where things came from), but writes
 * are gated to org admins.
 *
 * The two seeded registries are:
 *   - "curated"  — locked, always on
 *   - "mpak"     — toggleable
 *
 * Registry URLs (e.g., a self-hosted mpak) are deployment configuration,
 * not runtime state — set via the `NB_REGISTRIES` env var or by editing
 * `registries.json` directly. This tool intentionally has no `set_url`
 * action.
 */

export interface ManageRegistriesContext {
  runtime: Runtime;
  getIdentity: () => UserIdentity | null;
}

export function createManageRegistriesTool(ctx: ManageRegistriesContext): InProcessTool {
  return {
    name: "manage_registries",
    description:
      "List and configure connector registries (curated, mpak, future). Org admin gated for writes.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "enable", "disable", "rename"],
          description: "Action to perform.",
        },
        id: { type: "string", description: "Registry id (required for non-list actions)." },
        name: { type: "string", description: "New display name (rename only)." },
      },
      required: ["action"],
    },
    handler: async (input): Promise<ToolResult> => {
      const action = String(input.action ?? "");
      const store = ctx.runtime.getRegistryStore();

      if (action === "list") {
        return listRegistries(store);
      }

      // All write actions require an admin caller. The read above already
      // returned by this point, so the gate is correctly scoped.
      const denied = requireOrgAdmin(ctx.getIdentity());
      if (denied) return denied;

      const id = String(input.id ?? "");
      if (!id) {
        return { content: textContent("`id` is required."), isError: true };
      }

      try {
        return await runWriteAction(store, action, id, String(input.name ?? ""));
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}

/** The store handle a registry tool operates against. */
type RegistryStore = ReturnType<Runtime["getRegistryStore"]>;

/** Build the `list` result: every registry, readable by any signed-in user. */
async function listRegistries(store: RegistryStore): Promise<ToolResult> {
  const registries = await store.list();
  return {
    content: textContent(`Registries: ${registries.length}.`),
    structuredContent: { registries },
    isError: false,
  };
}

/** Guard write actions: return a denial result for non-admins, else null. */
function requireOrgAdmin(identity: UserIdentity | null): ToolResult | null {
  if (!identity || !ORG_ADMIN_ROLES.has(identity.orgRole)) {
    return {
      content: textContent("Org admin or owner role required to modify registries."),
      isError: true,
      structuredContent: { error: "permission_denied" },
    };
  }
  return null;
}

/** Dispatch an admin write action (enable/disable/rename) against the store. */
async function runWriteAction(
  store: RegistryStore,
  action: string,
  id: string,
  name: string,
): Promise<ToolResult> {
  switch (action) {
    case "enable": {
      const next = await store.update(id, { enabled: true });
      return {
        content: textContent(`Enabled "${next.name}".`),
        structuredContent: { ok: true, registry: next },
        isError: false,
      };
    }
    case "disable": {
      const next = await store.update(id, { enabled: false });
      return {
        content: textContent(`Disabled "${next.name}".`),
        structuredContent: { ok: true, registry: next },
        isError: false,
      };
    }
    case "rename": {
      if (!name) return { content: textContent("`name` is required."), isError: true };
      const next = await store.update(id, { name });
      return {
        content: textContent(`Renamed "${id}" to "${name}".`),
        structuredContent: { ok: true, registry: next },
        isError: false,
      };
    }
    default:
      return {
        content: textContent(`Unknown action "${action}".`),
        isError: true,
      };
  }
}

/** Normalize a thrown value into an error `ToolResult`. */
function errorResult(err: unknown): ToolResult {
  return {
    content: textContent(err instanceof Error ? err.message : String(err)),
    isError: true,
  };
}
