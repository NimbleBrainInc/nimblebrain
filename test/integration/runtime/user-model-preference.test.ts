import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import { runWithRequestContext } from "../../../src/runtime/request-context.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { createCoreToolDefs } from "../../../src/tools/core-source.ts";
import { provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-user-model-pref-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

const CONFIGURED_DEFAULT = "anthropic:claude-sonnet-4-6";
const CHOSEN = "anthropic:claude-opus-4-6";

async function start(name: string, allowlist?: string[]) {
  const workDir = join(testDir, name);
  mkdirSync(workDir, { recursive: true });
  const runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    models: { default: CONFIGURED_DEFAULT, fast: CONFIGURED_DEFAULT, reasoning: CONFIGURED_DEFAULT },
    ...(allowlist ? { providers: { anthropic: { apiKey: "k", models: allowlist } } } : {}),
    noDefaultBundles: true,
    workDir,
  });
  await provisionTestWorkspace(runtime);
  return runtime;
}

/** Read the slots as a caller whose profile carries `model`. */
function slotsFor(runtime: Runtime, model?: string) {
  const identity = {
    id: "usr_test",
    email: "t@example.com",
    displayName: "T",
    orgRole: "member",
    preferences: model === undefined ? {} : { models: { default: model } },
  } as unknown as UserIdentity;
  return runWithRequestContext({ identity, workspaceId: null } as never, () =>
    runtime.getModelSlots(),
  );
}

describe("a person's model choice applies to their turns", () => {
  it("overrides the configured default", async () => {
    const runtime = await start("applies");
    try {
      expect(slotsFor(runtime, CHOSEN).default).toBe(CHOSEN);
    } finally {
      await runtime.shutdown();
    }
  });

  it("leaves the configured default in place when unset", async () => {
    const runtime = await start("unset");
    try {
      expect(slotsFor(runtime).default).toBe(CONFIGURED_DEFAULT);
    } finally {
      await runtime.shutdown();
    }
  });

  // `fast` carries the full tool surface and its window sizes both history
  // folds. A person choosing a chat model must not be choosing that.
  it("moves only the default slot, never the auxiliary ones", async () => {
    const runtime = await start("default-only");
    try {
      const slots = slotsFor(runtime, CHOSEN);
      expect(slots.default).toBe(CHOSEN);
      expect(slots.fast).toBe(CONFIGURED_DEFAULT);
      expect(slots.reasoning).toBe(CONFIGURED_DEFAULT);
    } finally {
      await runtime.shutdown();
    }
  });
});

describe("a stored choice is re-checked, not trusted", () => {
  // The case a write-time check cannot cover: the preference was permitted
  // when saved and the allowlist narrowed afterwards. Falling through beats
  // failing the turn — the person keeps working on the configured default.
  it("falls back to the configured default when the choice is no longer permitted", async () => {
    const runtime = await start("narrowed", ["claude-sonnet-4-6"]);
    try {
      expect(slotsFor(runtime, CHOSEN).default).toBe(CONFIGURED_DEFAULT);
    } finally {
      await runtime.shutdown();
    }
  });

  it("honours a choice the allowlist permits", async () => {
    const runtime = await start("permitted", ["claude-sonnet-4-6", "claude-opus-4-6"]);
    try {
      expect(slotsFor(runtime, CHOSEN).default).toBe(CHOSEN);
    } finally {
      await runtime.shutdown();
    }
  });

  // A deployment that configured no allowlist has no policy, so a choice is
  // not denied by one it never set.
  it("honours any choice where no policy is configured", async () => {
    const runtime = await start("no-policy");
    try {
      expect(slotsFor(runtime, "some-proxy:pinned-build-42").default).toBe(
        "some-proxy:pinned-build-42",
      );
    } finally {
      await runtime.shutdown();
    }
  });
});

describe("saving a choice", () => {
  /** Invoke `set_preferences` through the real core tool, as the given user. */
  async function setPreference(runtime: Runtime, userId: string, model: string | null) {
    const identity = (await runtime.getUserStore().get(userId)) as unknown as UserIdentity;
    const tool = createCoreToolDefs(runtime).find((d) => d.name === "set_preferences");
    if (!tool) throw new Error("set_preferences tool not found");
    return runWithRequestContext({ identity, workspaceId: null } as never, () =>
      tool.handler({ model }),
    );
  }

  async function seedUser(runtime: Runtime) {
    const user = await runtime
      .getUserStore()
      .create({ email: "p@example.com", displayName: "P" });
    return user.id;
  }

  it("stores a permitted model and reads it back", async () => {
    const runtime = await start("save-ok", ["claude-sonnet-4-6", "claude-opus-4-6"]);
    try {
      const userId = await seedUser(runtime);
      const res = await setPreference(runtime, userId, CHOSEN);
      expect(res.isError).toBeFalsy();
      const user = await runtime.getUserStore().get(userId);
      expect(user?.preferences.models?.default).toBe(CHOSEN);
    } finally {
      await runtime.shutdown();
    }
  });

  // Told at the point of choosing, rather than silently ignored on the next
  // turn by the read-side fallback.
  it("refuses a model the allowlist excludes", async () => {
    const runtime = await start("save-refused", ["claude-sonnet-4-6"]);
    try {
      const userId = await seedUser(runtime);
      const res = await setPreference(runtime, userId, CHOSEN);
      expect(res.isError).toBe(true);
      const user = await runtime.getUserStore().get(userId);
      expect(user?.preferences.models?.default).toBeUndefined();
    } finally {
      await runtime.shutdown();
    }
  });

  it("clears the choice on null", async () => {
    const runtime = await start("save-clear", ["claude-sonnet-4-6", "claude-opus-4-6"]);
    try {
      const userId = await seedUser(runtime);
      await setPreference(runtime, userId, CHOSEN);
      await setPreference(runtime, userId, null);
      const user = await runtime.getUserStore().get(userId);
      expect(user?.preferences.models?.default).toBeUndefined();
    } finally {
      await runtime.shutdown();
    }
  });
});
