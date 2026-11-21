import { describe, expect, it } from "bun:test";
import type { Plugin } from "../src/_generated/platform-schemas/plugins";
import { pluginsForToolPattern } from "../src/lib/plugin-attribution";
import { skillLoadsText, skillMechanismLabel } from "../src/lib/skill-display";

// The resting mechanism line is the discriminator the flat catalog used to
// hide until a row was expanded — one string per loading mechanism, in the
// ledger's vocabulary. The glob tail is returned separately so the caller can
// render it in mono.
describe("skillMechanismLabel", () => {
  it("names an always-on skill", () => {
    expect(skillMechanismLabel({ loading: { mechanism: "always" } })).toEqual({
      text: "Always on · every conversation",
    });
  });

  it("names a tool-affinity skill and returns its globs as a mono tail", () => {
    expect(
      skillMechanismLabel({
        loading: { mechanism: "tool_affinity" },
        toolAffinity: ["docs__*"],
      }),
    ).toEqual({ text: "On tool match", mono: "docs__*" });
  });

  it("joins multiple tool globs into one mono tail", () => {
    expect(
      skillMechanismLabel({
        loading: { mechanism: "tool_affinity" },
        toolAffinity: ["docs__*", "github__*"],
      }),
    ).toEqual({ text: "On tool match", mono: "docs__*, github__*" });
  });

  it("quotes a trigger phrase inline (no mono tail)", () => {
    expect(
      skillMechanismLabel({
        loading: { mechanism: "trigger" },
        triggers: ["cut a release"],
      }),
    ).toEqual({ text: 'On trigger "cut a release"' });
  });

  it("says a catalog-only skill loads when the agent asks for it", () => {
    expect(skillMechanismLabel({ loading: { mechanism: "on_request" } })).toEqual({
      text: "When the agent asks for it",
    });
  });

  it("names the mechanism even when its payload is empty", () => {
    expect(skillMechanismLabel({ loading: { mechanism: "tool_affinity" } })).toEqual({
      text: "On tool match",
    });
    expect(skillMechanismLabel({ loading: { mechanism: "trigger" }, triggers: [] })).toEqual({
      text: "On trigger",
    });
  });

  it("returns null when the derived loading field is absent", () => {
    // `skills__list` always populates `loading`. Absent means genuinely
    // unknown, so the row states nothing rather than claiming "won't load".
    expect(skillMechanismLabel({})).toBeNull();
  });
});

function plugin(id: string, displayName: string, kind: "person" | "workspace"): Plugin {
  return {
    id: `${kind}:${id}`,
    displayName,
    owner: { kind },
    granted: true,
    servers: [{ serverName: id, status: "ready", account: null }],
    skills: [],
    apps: [],
  };
}

const CALENDAR = plugin("com-google-calendar-mcp", "Google Calendar", "person");
const GMAIL = plugin("gmail", "Gmail", "workspace");
const MY_GMAIL = plugin("gmail", "My Gmail", "person");
const PLUGINS = [CALENDAR, GMAIL, MY_GMAIL];

describe("pluginsForToolPattern", () => {
  it("names a personal plugin by its my_ marked source, a workspace one by its bare one", () => {
    expect(pluginsForToolPattern("my_com-google-calendar-mcp__*", PLUGINS)).toEqual([CALENDAR]);
    expect(pluginsForToolPattern("gmail__send", PLUGINS)).toEqual([GMAIL]);
    expect(pluginsForToolPattern("my_gmail__*", PLUGINS)).toEqual([MY_GMAIL]);
  });

  it("matches a wildcard source against every plugin it reaches", () => {
    expect(pluginsForToolPattern("*gmail__*", PLUGINS)).toEqual([GMAIL, MY_GMAIL]);
    expect(pluginsForToolPattern("gmail*", PLUGINS)).toEqual([GMAIL]);
  });

  it("names none for every tool, a bare tool name, or an unknown source", () => {
    expect(pluginsForToolPattern("*", PLUGINS)).toEqual([]);
    expect(pluginsForToolPattern("*__send", PLUGINS)).toEqual([]);
    expect(pluginsForToolPattern("send", PLUGINS)).toEqual([]);
    expect(pluginsForToolPattern("docs__*", PLUGINS)).toEqual([]);
  });
});

describe("skillLoadsText", () => {
  const affinity = (toolAffinity: string[]) => ({
    loading: { mechanism: "tool_affinity" as const },
    toolAffinity,
  });

  it("names the plugin a tool pattern reaches, never the pattern", () => {
    expect(skillLoadsText(affinity(["my_com-google-calendar-mcp__*"]), PLUGINS)).toBe(
      "When Google Calendar is used",
    );
  });

  it("joins several plugins with or", () => {
    expect(skillLoadsText(affinity(["gmail__*", "my_gmail__*"]), PLUGINS)).toBe(
      "When Gmail or My Gmail is used",
    );
    expect(
      skillLoadsText(
        affinity(["gmail__*", "my_gmail__*", "my_com-google-calendar-mcp__*"]),
        PLUGINS,
      ),
    ).toBe("When Gmail, My Gmail or Google Calendar is used");
  });

  it("says a matching tool when no plugin answers a pattern", () => {
    expect(skillLoadsText(affinity(["docs__*"]), PLUGINS)).toBe("When a matching tool is used");
    expect(skillLoadsText(affinity([]), PLUGINS)).toBe("When a matching tool is used");
    expect(skillLoadsText(affinity(["gmail__*", "docs__*"]), PLUGINS)).toBe(
      "When Gmail or a matching tool is used",
    );
  });

  it("says always on and trigger phrases plainly", () => {
    expect(skillLoadsText({ loading: { mechanism: "always" } }, [])).toBe("Always on");
    expect(
      skillLoadsText({ loading: { mechanism: "trigger" }, triggers: ["deploy", "ship"] }, []),
    ).toBe('On trigger "deploy", "ship"');
  });

  it("leaves out the default unless asked for it", () => {
    const asked = { loading: { mechanism: "on_request" as const } };
    expect(skillLoadsText(asked, [])).toBeNull();
    expect(skillLoadsText(asked, [], { includeDefault: true })).toBe("When the agent asks for it");
    expect(skillLoadsText({}, [], { includeDefault: true })).toBeNull();
  });
});
