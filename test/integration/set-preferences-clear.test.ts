/**
 * A person clears a preference with `null` and the deployment's default
 * applies again: the key leaves the stored profile, the prompt states the
 * operator's timezone, and every read path names the default it fell back to.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleBootstrap } from "../../src/api/handlers.ts";
import type { BootstrapResponse } from "../../src/api/schemas/responses.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import {
  type OwnPreferences,
  type PreferenceDefaults,
  SetPreferencesInput,
  type SetPreferencesOutput,
} from "../../src/platform/schemas/preferences.ts";
import { composeSystemPrompt } from "../../src/prompt/compose.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createCoreToolDefs } from "../../src/tools/core-source.ts";
import { validateToolInput } from "../../src/tools/validate-input.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace } from "../helpers/test-workspace.ts";

const OPERATOR_TZ = "Pacific/Honolulu";
const CONFIGURED_MODEL = "anthropic:claude-sonnet-4-6";
const testDir = join(tmpdir(), `nb-set-prefs-clear-${Date.now()}`);
const previousTz = process.env.NB_TIMEZONE;

let runtime: Runtime;
let workDir: string;

beforeAll(async () => {
  // Read once, when the runtime is built.
  process.env.NB_TIMEZONE = OPERATOR_TZ;
  workDir = join(testDir, "rt");
  mkdirSync(workDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    models: { default: CONFIGURED_MODEL, fast: CONFIGURED_MODEL },
    workDir,
  });
  await provisionTestWorkspace(runtime);
});

afterAll(async () => {
  await runtime.shutdown();
  if (previousTz === undefined) delete process.env.NB_TIMEZONE;
  else process.env.NB_TIMEZONE = previousTz;
  rmSync(testDir, { recursive: true, force: true });
});

async function seedUser(): Promise<string> {
  const user = await runtime
    .getUserStore()
    .create({ email: `p-${crypto.randomUUID()}@example.com`, displayName: "P" });
  return user.id;
}

async function asUser<T>(userId: string, fn: (identity: UserIdentity) => Promise<T>): Promise<T> {
  const identity: UserIdentity | null = await runtime.getUserStore().get(userId);
  if (!identity) throw new Error(`user ${userId} not found`);
  return runWithRequestContext({ identity }, () => fn(identity));
}

function tool(name: string) {
  const def = createCoreToolDefs(runtime).find((d) => d.name === name);
  if (!def) throw new Error(`${name} not found`);
  return def;
}

const setPreferences = (userId: string, input: SetPreferencesInput) =>
  asUser(userId, () => tool("set_preferences").handler(input));

/** The profile as it sits on disk, so a clear is seen to remove the key. */
function storedPreferences(userId: string): Record<string, unknown> {
  const raw = readFileSync(join(workDir, "users", userId, "profile.json"), "utf-8");
  return (JSON.parse(raw) as { preferences: Record<string, unknown> }).preferences;
}

describe("set_preferences clears a preference with null", () => {
  it("removes the timezone from the profile, and the operator default applies", async () => {
    const userId = await seedUser();
    const set = await setPreferences(userId, { timezone: "Europe/Berlin" });
    expect(set.isError).toBe(false);
    expect((set.structuredContent as SetPreferencesOutput).effective.timezone).toEqual({
      value: "Europe/Berlin",
      source: "own",
    });

    const cleared = await setPreferences(userId, { timezone: null });
    expect(cleared.isError).toBe(false);
    const out = cleared.structuredContent as SetPreferencesOutput;
    expect(out.preferences.timezone).toBeUndefined();
    expect(out.effective.timezone).toEqual({ value: OPERATOR_TZ, source: "default" });
    expect("timezone" in storedPreferences(userId)).toBe(false);

    // The prompt states the default, as it does for someone who never set one.
    const prefs = await asUser(userId, (identity) => runtime.promptPrefsFor(identity));
    expect(prefs.timezone).toBe(OPERATOR_TZ);
    const prompt = composeSystemPrompt([], null, undefined, undefined, undefined, prefs);
    expect(prompt).toContain(`- Timezone: ${OPERATOR_TZ}`);
  });

  it("clears locale, theme and model each on its own, leaving no empty husk", async () => {
    const userId = await seedUser();
    await setPreferences(userId, {
      locale: "de-DE",
      theme: "dark",
      timezone: "Asia/Tokyo",
      model: CONFIGURED_MODEL,
    });
    const res = await setPreferences(userId, { locale: null, theme: null, model: null });
    expect(res.isError).toBe(false);
    const stored = storedPreferences(userId);
    expect(stored).toEqual({ timezone: "Asia/Tokyo" });
    const out = res.structuredContent as SetPreferencesOutput;
    expect(out.effective.locale).toEqual({ value: "en-US", source: "default" });
    expect(out.effective.theme).toEqual({ value: "system", source: "default" });
    expect(out.effective.model).toEqual({ value: CONFIGURED_MODEL, source: "default" });
    expect(out.effective.timezone).toEqual({ value: "Asia/Tokyo", source: "own" });
  });

  it('refuses "" and names null as the clear, storing nothing', async () => {
    const userId = await seedUser();
    await setPreferences(userId, { timezone: "Europe/Berlin" });
    for (const input of [{ timezone: "" }, { locale: "  " }, { model: "" }]) {
      const res = await setPreferences(userId, input);
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain("Pass null to clear it");
    }
    expect(storedPreferences(userId)).toEqual({ timezone: "Europe/Berlin" });
  });

  it("refuses a timezone Intl does not know", async () => {
    const userId = await seedUser();
    const res = await setPreferences(userId, { timezone: "Mars/Olympus_Mons" });
    expect(res.isError).toBe(true);
    expect(storedPreferences(userId)).toEqual({});
  });

  it("takes null on every clearable field and refuses an unknown one, at the schema", () => {
    for (const key of ["timezone", "locale", "theme", "model"]) {
      expect(validateToolInput({ [key]: null }, SetPreferencesInput).valid).toBe(true);
    }
    expect(validateToolInput({ displayName: null }, SetPreferencesInput).valid).toBe(false);
    expect(validateToolInput({ tz: "UTC" }, SetPreferencesInput).valid).toBe(false);
  });
});

describe("the read paths name the default an unset preference falls back to", () => {
  const defaults: PreferenceDefaults = {
    timezone: OPERATOR_TZ,
    locale: "en-US",
    theme: "system",
    model: CONFIGURED_MODEL,
  };

  it("get_config reports only what the person set, beside the defaults", async () => {
    const userId = await seedUser();
    await setPreferences(userId, { timezone: "Europe/Berlin" });
    await setPreferences(userId, { timezone: null });
    const res = await asUser(userId, () => tool("get_config").handler({}));
    const config = res.structuredContent as {
      preferences: OwnPreferences & { displayName: string };
      preferenceDefaults: PreferenceDefaults;
    };
    expect(config.preferences).toEqual({ displayName: "P" });
    expect(config.preferenceDefaults).toEqual(defaults);
  });

  it("bootstrap carries the defaults beside the person's preferences", async () => {
    const userId = await seedUser();
    await setPreferences(userId, { locale: "fr-FR" });
    const identity: UserIdentity | null = await runtime.getUserStore().get(userId);
    if (!identity) throw new Error("user not found");
    const body = (await (await handleBootstrap(runtime, identity)).json()) as BootstrapResponse;
    expect(body.user.preferences).toEqual({ locale: "fr-FR" });
    expect(body.user.preferenceDefaults).toEqual(defaults);
  });
});
