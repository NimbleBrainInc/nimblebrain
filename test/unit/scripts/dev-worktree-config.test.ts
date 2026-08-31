import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildDevWorktreeSeed } from "../../../scripts/lib/dev-worktree-config.ts";
import { getValidator } from "../../../src/config/index.ts";

describe("buildDevWorktreeSeed", () => {
  test("produces a config accepted by the runtime schema", () => {
    const root = "/tmp/nimblebrain-worktree";
    const seed = buildDevWorktreeSeed(root, join(root, ".nimblebrain-worktree"));
    const validate = getValidator();

    expect(validate(seed)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  test("preserves an explicit workdir override", () => {
    expect(buildDevWorktreeSeed("/repo", "/var/lib/nimblebrain").workDir).toBe(
      "/var/lib/nimblebrain",
    );
  });
});
