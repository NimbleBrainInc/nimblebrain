import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import { ModelNotAllowedError } from "../../../src/runtime/errors.ts";
import { runWithRequestContext } from "../../../src/runtime/request-context.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { createCoreToolDefs } from "../../../src/tools/core-source.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../../helpers/test-workspace.ts";

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
    models: { default: CONFIGURED_DEFAULT, fast: CONFIGURED_DEFAULT },
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
  it("moves only the default slot, never the auxiliary one", async () => {
    const runtime = await start("default-only");
    try {
      const slots = slotsFor(runtime, CHOSEN);
      expect(slots.default).toBe(CHOSEN);
      expect(slots.fast).toBe(CONFIGURED_DEFAULT);
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
  const user = await runtime.getUserStore().create({ email: "p@example.com", displayName: "P" });
  return user.id;
}

describe("saving a choice", () => {
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

describe("an empty model id is not a choice", () => {
  // `get_config` reports an unset preference as `""`, so a client that reads
  // preferences and writes them back sends `""`. Storing it would resolve to
  // `anthropic:` — the bare-id fallback applied to nothing — and pin every
  // conversation that user starts to a model that cannot answer, which they
  // could not correct from chat because correcting it needs a turn.
  it("clears rather than storing, round-tripping the unset sentinel", async () => {
    const runtime = await start("empty-clears");
    try {
      const userId = await seedUser(runtime);
      await setPreference(runtime, userId, CHOSEN);
      const res = await setPreference(runtime, userId, "");
      expect(res.isError).toBeFalsy();
      const user = await runtime.getUserStore().get(userId);
      expect(user?.preferences.models?.default).toBeUndefined();
    } finally {
      await runtime.shutdown();
    }
  });

  // Driven through chat, not through the predicate. Asserting
  // `isModelPermitted("")` passes whether or not the request path reaches the
  // floor before qualification — which is how the previous version of this
  // test stayed green while `POST /v1/chat {"model":""}` still went through.
  it("is refused on the request path, where it is malformed rather than a clear", async () => {
    const runtime = await start("empty-request");
    try {
      for (const model of ["", "   "]) {
        const err = await runtime
          .chat({ message: "hi", workspaceId: TEST_WORKSPACE_ID, model })
          .then(
            () => null,
            (e) => e,
          );
        expect(err).toBeInstanceOf(ModelNotAllowedError);
      }
    } finally {
      await runtime.shutdown();
    }
  });
});

describe("a caller's own choice never becomes everyone's default", () => {
  // `updateConfig` seeds `config.models` from the slot reader when the key is
  // absent. That reader is tinted by whoever is asking, so an admin with a
  // personal model writing any unrelated slot would promote their own choice
  // to the process-wide default — and silently diverge from the override file
  // just written.
  it("seeds process config from the configured slots, not the caller's view", async () => {
    // No `models` key: that is the only shape where `updateConfig` seeds, and
    // so the only shape where the caller's view could be what it seeds from.
    const workDir = join(testDir, "no-leak");
    mkdirSync(workDir, { recursive: true });
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });
    await provisionTestWorkspace(runtime);
    try {
      const identity = {
        id: "usr_admin",
        email: "a@example.com",
        displayName: "A",
        orgRole: "owner",
        preferences: { models: { default: CHOSEN } },
      } as unknown as UserIdentity;

      runWithRequestContext({ identity, workspaceId: null } as never, () =>
        runtime.updateConfig({ models: { fast: "anthropic:claude-haiku-4-5-20251001" } }),
      );

      // Read back as somebody with no preference of their own: they must see
      // the platform default, not the admin's personal pick.
      expect(slotsFor(runtime).default).not.toBe(CHOSEN);
    } finally {
      await runtime.shutdown();
    }
  });
});

describe("the settings view is the configured one", () => {
  // get_config feeds the settings tab, which posts what it was given back on
  // Save. A caller-tinted value there does not merely display wrong — an admin
  // with a personal model persists it as everyone's default by clicking Save.
  it("reports configured slots to an admin who has a personal choice", async () => {
    const workDir = join(testDir, "settings-view");
    mkdirSync(workDir, { recursive: true });
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      models: { default: CONFIGURED_DEFAULT, fast: CONFIGURED_DEFAULT },
      noDefaultBundles: true,
      workDir,
    });
    await provisionTestWorkspace(runtime);
    try {
      const identity = {
        id: "usr_admin",
        email: "a@example.com",
        displayName: "A",
        orgRole: "owner",
        preferences: { models: { default: CHOSEN } },
      } as unknown as UserIdentity;

      const tool = createCoreToolDefs(runtime).find((d) => d.name === "get_config");
      if (!tool) throw new Error("get_config not found");
      const { config, slots } = await runWithRequestContext(
        { identity, workspaceId: null } as never,
        async () => ({
          config: (await tool.handler({})).structuredContent as {
            models: { default: string };
            newConversationModel: string;
          },
          slots: runtime.getModelSlots(),
        }),
      );

      // The same caller, in the same context, sees both: their own choice on
      // the turn, and the untinted configured value on the settings surface.
      expect(slots.default).toBe(CHOSEN);
      expect(config.models.default).toBe(CONFIGURED_DEFAULT);
      // And a third value in the same payload, deliberately unlike the second:
      // the composer names what the next conversation will be pinned to, which
      // is the caller's choice. Deriving it from `models.default` would name
      // the wrong model to everyone who has a preference.
      expect(config.newConversationModel).toBe(CHOSEN);
    } finally {
      await runtime.shutdown();
    }
  });
});
