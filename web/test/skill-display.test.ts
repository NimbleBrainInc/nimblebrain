import { describe, expect, it } from "bun:test";
import { skillMechanismLabel } from "../src/lib/skill-display";

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
        toolAffinity: ["mpak__*"],
      }),
    ).toEqual({ text: "On tool match", mono: "mpak__*" });
  });

  it("joins multiple tool globs into one mono tail", () => {
    expect(
      skillMechanismLabel({
        loading: { mechanism: "tool_affinity" },
        toolAffinity: ["mpak__*", "github__*"],
      }),
    ).toEqual({ text: "On tool match", mono: "mpak__*, github__*" });
  });

  it("quotes a trigger phrase inline (no mono tail)", () => {
    expect(
      skillMechanismLabel({
        loading: { mechanism: "trigger" },
        triggers: ["cut a release"],
      }),
    ).toEqual({ text: 'On trigger "cut a release"' });
  });

  it("renders the honesty state for a skill no loader reaches", () => {
    expect(skillMechanismLabel({ loading: { mechanism: "none" } })).toEqual({
      text: "Won't auto-load yet",
    });
  });

  it("falls back to loadingStrategy when the derived loading field is absent", () => {
    expect(skillMechanismLabel({ loadingStrategy: "always" })).toEqual({
      text: "Always on · every conversation",
    });
    // No loading info at all → the honesty state, never a silent "on demand".
    expect(skillMechanismLabel({})).toEqual({ text: "Won't auto-load yet" });
  });
});
