/**
 * The recorded `name` is the answer; the derivation is only for runs recorded
 * before that field existed. Its one hard case is the SEP-2640 entrypoint —
 * every connector skill's id ends in `/SKILL.md`, so a reader that takes the
 * last path segment names all of them `SKILL`.
 */

import { describe, expect, test } from "bun:test";
import { skillDisplayName } from "../../../src/skills/display-name.ts";

describe("skillDisplayName", () => {
  test("prefers the recorded name over anything derivable from the id", () => {
    expect(skillDisplayName({ id: "skill://acme/billing/SKILL.md", name: "billing" })).toBe(
      "billing",
    );
    // A recorded name wins even when it disagrees with the path.
    expect(skillDisplayName({ id: "/work/skills/old-path.md", name: "renamed" })).toBe("renamed");
  });

  test("names a connector skill by its directory, not the entrypoint file", () => {
    expect(skillDisplayName({ id: "skill://acme/billing/refunds/SKILL.md" })).toBe("refunds");
    expect(skillDisplayName({ id: "skill://git-workflow/SKILL.md" })).toBe("git-workflow");
  });

  test("strips the extension from a filesystem skill", () => {
    expect(skillDisplayName({ id: "/work/skills/release-notes.md" })).toBe("release-notes");
    expect(skillDisplayName({ id: "release-notes.md" })).toBe("release-notes");
  });

  test("handles the in-memory sentinel and an empty name", () => {
    expect(skillDisplayName({ id: "skill-in-memory:identity-override" })).toBe(
      "skill-in-memory:identity-override",
    );
    expect(skillDisplayName({ id: "/work/skills/x.md", name: "" })).toBe("x");
  });

  test("a bare SKILL.md with no directory falls back to the segment itself", () => {
    expect(skillDisplayName({ id: "SKILL.md" })).toBe("SKILL");
  });
});
