/**
 * Outputs resolvable source (task 007).
 *
 * Exposes stored outputs through the MCP resource path so
 * `nb__read_resource(files://<id>)` resolves a past output. `read_resource`
 * already iterates every `McpSource` calling `readResource(uri)` and returns
 * the first hit (see `src/tools/system-tools.ts`); this source plugs into that
 * loop via a `resourceHandler` — there is NO parallel resolver here.
 *
 * Why a dedicated source rather than relying on the `files` source: the local
 * output backend writes into the identity-owned file store, so its outputs
 * already resolve through `files`. The DATAPLANE backend's outputs live in the
 * artifacts service — a `files://<artifactId>` ref has no entry in the local
 * file store and would 404 there. This source resolves through the active
 * `OutputStore`, so the SAME `files://` ref resolves for both backends.
 *
 * This is the bounded "peek": `read_resource` applies its existing 12K cap to
 * the returned text (motivating `nb__get_output` for the full body). The
 * handler returns the whole body; the cap is applied by the read_resource tool,
 * exactly as it is for every other source.
 *
 * Registered only when an output-store provider resolves (dataplane | local),
 * mirroring how `deepResearchCtx` / `getOutputCtx` gate their surfaces. When the
 * provider is `null` the source is absent.
 */

import type { EventSink } from "../engine/types.ts";
import { isTextMime } from "../files/mime.ts";
import { type OutputStore, outputRefToId } from "../files/output-store.ts";
import { defineInProcessApp, type InProcessResource } from "./in-process-app.ts";
import type { McpSource } from "./mcp-source.ts";

export interface OutputsSourceContext {
  /** Current request workspace — the scope for the resolve. `null` ⇒ no resolution. */
  getWorkspaceId: () => string | null;
  /** The resolved output store (dataplane | local). */
  store: OutputStore;
}

/**
 * Build the `outputs` in-process source. It serves no tools — only the
 * `files://` resource resolution path. Returns an UNSTARTED source (the caller
 * starts it alongside the other workspace sources, as `createSystemTools` does
 * for the `nb` source).
 */
export function createOutputsSource(ctx: OutputsSourceContext, eventSink: EventSink): McpSource {
  const resourceHandler = async (uri: string): Promise<InProcessResource | null> => {
    const id = outputRefToId(uri);
    if (!id) return null; // not a files:// ref — let another source try.

    const workspace = ctx.getWorkspaceId();
    if (!workspace) return null; // no workspace bound — resolve nothing.

    try {
      const content = await ctx.store.get({ workspace }, id);

      // Fence the identity-owned local store the same way `nb__get_output`
      // does: if the stored output records a different workspace, treat it as
      // not-found rather than leaking it across the scope boundary. (The
      // dataplane backend already fenced at the RLS boundary.)
      if (content.meta.workspace && content.meta.workspace !== workspace) {
        return null;
      }

      // Return the FULL body; read_resource applies its own 12K peek cap. Text
      // MIMEs come back as `text` (so read_resource can truncate + show them);
      // everything else as a `blob` (read_resource reports it as binary).
      if (isTextMime(content.meta.mime)) {
        return {
          text: new TextDecoder().decode(content.body),
          mimeType: content.meta.mime,
        };
      }
      return { blob: content.body, mimeType: content.meta.mime };
    } catch {
      // Unknown id / store error → not-found. Falls through the read_resource
      // loop cleanly (no crash, no leak).
      return null;
    }
  };

  return defineInProcessApp(
    {
      name: "outputs",
      version: "1.0.0",
      tools: [],
      // No static catalog — outputs are resolved on demand by ref. We don't
      // enumerate them in resources/list (a workspace can have many; listing is
      // `OutputStore.list`, not a resource walk). The handler alone satisfies
      // the read_resource resolution path.
      resourceHandler,
    },
    eventSink,
  );
}
