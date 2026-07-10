// ---------------------------------------------------------------------------
// Chat is workspace-only — the command-palette gate.
//
// Pins the palette half of the Option-B invariant: the "Open / close chat"
// action is available only on a workspace route (`/w/:slug`), never on the
// identity/home surfaces (`/`, `/profile/...`). The ShellLayout mount gate
// (`{isWorkspaceRoute && <ChatChrome/>}`) is a trivial conditional verified by
// tsc + `verify:static`; a full render test isn't worth process-global
// `mock.module` of shared shell modules (WorkspaceNav / ArtifactPanel / the
// contexts), which leaks into and breaks their own suites — see test/setup.ts.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { ACTIONS } from "../components/palette/actions";
import type { CommandSourceContext } from "../components/palette/types";

const ctx = (isWorkspaceRoute: boolean): CommandSourceContext =>
  ({ isWorkspaceRoute }) as CommandSourceContext;

describe("chat is workspace-only — palette gate", () => {
  test("the 'Open / close chat' action is available only on a workspace route", () => {
    const toggleChat = ACTIONS.find((a) => a.id === "toggle-chat");
    expect(toggleChat).toBeDefined();
    expect(toggleChat?.available).toBeDefined();
    // On a `/w/:slug` route → offered; on home / profile → hidden.
    expect(toggleChat?.available?.(ctx(true))).toBe(true);
    expect(toggleChat?.available?.(ctx(false))).toBe(false);
  });
});
