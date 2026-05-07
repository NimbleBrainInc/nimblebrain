import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
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
 *   - "mpak"     — toggleable; admin can override the URL to point
 *     at a private mpak instance
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
          enum: ["list", "enable", "disable", "set_url", "rename"],
          description: "Action to perform.",
        },
        id: { type: "string", description: "Registry id (required for non-list actions)." },
        url: { type: "string", description: "New registry URL (set_url only)." },
        name: { type: "string", description: "New display name (rename only)." },
      },
      required: ["action"],
    },
    handler: async (input): Promise<ToolResult> => {
      const action = String(input.action ?? "");
      const store = ctx.runtime.getRegistryStore();

      if (action === "list") {
        const registries = await store.list();
        return {
          content: textContent(`Registries: ${registries.length}.`),
          structuredContent: { registries },
          isError: false,
        };
      }

      // All write actions require an admin caller. Reads above already
      // returned by this point, so the gate is correctly scoped.
      const identity = ctx.getIdentity();
      if (!identity || (identity.orgRole !== "admin" && identity.orgRole !== "owner")) {
        return {
          content: textContent("Org admin or owner role required to modify registries."),
          isError: true,
          structuredContent: { error: "permission_denied" },
        };
      }

      const id = String(input.id ?? "");
      if (!id) {
        return { content: textContent("`id` is required."), isError: true };
      }

      try {
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
          case "set_url": {
            const url = String(input.url ?? "");
            if (!url) return { content: textContent("`url` is required."), isError: true };
            // Cheap shape check — full URL parsing happens at registry
            // load time. This guards against pasting a server name
            // without a scheme. Restrict to http(s) — registry URLs
            // only ever contact remote endpoints; `javascript:` /
            // `file:` / `data:` schemes have no business here, even
            // org-admin gated.
            let parsed: URL;
            try {
              parsed = new URL(url);
            } catch {
              return {
                content: textContent(`Invalid URL: ${url}`),
                isError: true,
              };
            }
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
              return {
                content: textContent(
                  `Registry URL must use http or https — got "${parsed.protocol}".`,
                ),
                isError: true,
              };
            }
            const next = await store.update(id, { url });
            return {
              content: textContent(`Updated "${next.name}" URL to ${url}.`),
              structuredContent: { ok: true, registry: next },
              isError: false,
            };
          }
          case "rename": {
            const name = String(input.name ?? "");
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
      } catch (err) {
        return {
          content: textContent(err instanceof Error ? err.message : String(err)),
          isError: true,
        };
      }
    },
  };
}
