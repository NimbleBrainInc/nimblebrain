// ---------------------------------------------------------------------------
// open_app — the agent's way to put an app on the user's screen.
//
// The tool decides nothing about the screen itself. It checks that the app
// exists in the conversation's workspace and answers; the web client that
// sent the turn sees the call complete in its own live stream and runs the
// shell's `openApp` action with the same arguments — the one place the shell
// is moved, shared with apps' `ai.nimblebrain/action`. A `target` is a view's
// stable address inside the app (its resource URI when it has one, the same
// value the app reports in `ai.nimblebrain/location`); the shell hands it to
// the app as `ai.nimblebrain/navigate` once the app is on screen.
//
// Only that client acts, and only on its own live turn: a conversation
// reloaded from history, reattached after a reload, or watched from another
// tab never moves anyone's screen.
// ---------------------------------------------------------------------------

import type { PlacementEntry } from "../connectors/runtime/types.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { InProcessTool } from "./in-process-app.ts";

export const OPEN_APP_TOOL = "open_app";

/** A placement the user can open: it has a route and sits in the shell's nav. */
function isOpenable(p: PlacementEntry): boolean {
  return Boolean(p.route) && (p.slot === "main" || p.slot.startsWith("sidebar"));
}

/**
 * The placement `app` names in a workspace's placements: an exact route first,
 * then a server name, then a case-insensitive label. The shell resolves the
 * same route and server-name forms, so whatever this accepts, it can open.
 */
export function findOpenableApp(
  placements: readonly PlacementEntry[],
  app: string,
): PlacementEntry | undefined {
  const openable = placements.filter(isOpenable);
  const wanted = app.trim().toLowerCase();
  return (
    openable.find((p) => p.route === app) ??
    openable.find((p) => p.serverName === app) ??
    openable.find((p) => p.label?.toLowerCase() === wanted)
  );
}

/** Each openable app's display name, for an error that lets the model retry. */
export function openableAppNames(placements: readonly PlacementEntry[]): string[] {
  return [...new Set(placements.filter(isOpenable).map((p) => p.label ?? p.route ?? p.serverName))];
}

export function createOpenAppTool(runtime: Runtime): InProcessTool {
  return {
    name: OPEN_APP_TOOL,
    description:
      'Open an app on the user\'s screen, optionally at a specific view inside it. Use it when the user asks to open, show, or go to an app or a record ("open People", "show me Chris in People"). To open a record, first find it with the app\'s own tools, then pass its resource URI (a row\'s `uri`) as `target`. The app opens either way; it goes to the target only if it supports opening at that address, so do not tell the user the record is on screen, only that the app is open at it if the app supports that. Opens only on the screen of the user who asked, in the conversation they are watching.',
    inputSchema: {
      type: "object",
      properties: {
        app: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "The app, by its name as the sidebar shows it (e.g. 'People') or its id.",
        },
        target: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description:
            "The view to open inside the app: its stable address, the record's resource URI when it has one. An app that does not support opening at an address opens on its home screen instead. Omit to open the app's home.",
        },
      },
      required: ["app"],
      additionalProperties: false,
    },
    handler: async (input): Promise<ToolResult> => {
      const app = typeof input.app === "string" ? input.app : "";
      const target = typeof input.target === "string" ? input.target : undefined;
      const wsId = runtime.requireWorkspaceId();
      const placements = runtime.getPlacementRegistry().forWorkspace(wsId);
      const found = findOpenableApp(placements, app);
      if (!found) {
        const names = openableAppNames(placements);
        return {
          content: textContent(
            `No app named "${app}" in this workspace. Apps: ${names.join(", ") || "none"}.`,
          ),
          isError: true,
        };
      }
      const name = found.label ?? found.route ?? found.serverName;
      return {
        // The app, not this server, decides whether it can go to `target`, and
        // nothing reports back whether it did, so the answer claims only what
        // is known: the app is opening, and the target was asked for.
        content: textContent(
          target
            ? `Opening ${name}, asking it to go to ${target}. ${name} goes there if it supports opening at that address; otherwise it shows its home screen.`
            : `Opening ${name}.`,
        ),
        structuredContent: {
          app: found.route ?? found.serverName,
          name,
          ...(target ? { target } : {}),
        },
        isError: false,
      };
    },
  };
}
