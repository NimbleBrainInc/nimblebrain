import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { effectiveTimezone, resolveOperatorTimezone } from "../../src/identity/timezone.ts";
import { UserStore } from "../../src/identity/user.ts";
import { composeSystemPrompt } from "../../src/prompt/compose.ts";
import { Runtime } from "../../src/runtime/runtime.ts";

describe("resolveOperatorTimezone", () => {
  it("takes a known IANA name", () => {
    expect(resolveOperatorTimezone("Pacific/Honolulu")).toBe("Pacific/Honolulu");
  });

  it("is UTC when unset or blank", () => {
    expect(resolveOperatorTimezone(undefined)).toBe("UTC");
    expect(resolveOperatorTimezone("  ")).toBe("UTC");
  });

  it("is UTC for a name Intl does not know", () => {
    expect(resolveOperatorTimezone("Mars/Olympus_Mons")).toBe("UTC");
  });
});

describe("effectiveTimezone", () => {
  it("is the profile's timezone when it names one: the person's choice wins", () => {
    expect(effectiveTimezone({ timezone: "Europe/Berlin" }, "Pacific/Honolulu")).toBe(
      "Europe/Berlin",
    );
  });

  it("is the operator default when the profile names none", () => {
    expect(effectiveTimezone({}, "Pacific/Honolulu")).toBe("Pacific/Honolulu");
    expect(effectiveTimezone({ timezone: "" }, "Pacific/Honolulu")).toBe("Pacific/Honolulu");
    expect(effectiveTimezone(undefined, "Pacific/Honolulu")).toBe("Pacific/Honolulu");
  });

  it("is the operator default when the profile's name is unknown", () => {
    expect(effectiveTimezone({ timezone: "Not/AZone" }, "Pacific/Honolulu")).toBe(
      "Pacific/Honolulu",
    );
  });

  it("is UTC with neither", () => {
    expect(effectiveTimezone({}, resolveOperatorTimezone(undefined))).toBe("UTC");
  });
});

/** A runtime with only the fields `promptPrefsFor` reads. */
function runtimeWith(operatorTimezone: string, userStore: UserStore): Runtime {
  const runtime = Object.create(Runtime.prototype) as Runtime;
  Object.assign(runtime, { _operatorTimezone: operatorTimezone, _userStore: userStore });
  return runtime;
}

function identity(preferences: UserIdentity["preferences"] | undefined): UserIdentity {
  return {
    id: "usr_a",
    email: "a@example.com",
    displayName: "Ada",
    orgRole: "member",
    ...(preferences ? { preferences } : {}),
  } as UserIdentity;
}

describe("Runtime.promptPrefsFor", () => {
  const store = () => new UserStore(mkdtempSync(join(tmpdir(), "nb-tz-")));

  it("states the profile's timezone", async () => {
    const runtime = runtimeWith("Pacific/Honolulu", store());
    const prefs = await runtime.promptPrefsFor(identity({ timezone: "Europe/Berlin" }));
    expect(prefs.timezone).toBe("Europe/Berlin");
  });

  it("states the operator default for a profile without one", async () => {
    const runtime = runtimeWith("Pacific/Honolulu", store());
    const prefs = await runtime.promptPrefsFor(identity({}));
    expect(prefs.timezone).toBe("Pacific/Honolulu");
  });

  it("states UTC with no profile timezone and no operator default", async () => {
    const runtime = runtimeWith(resolveOperatorTimezone(undefined), store());
    expect((await runtime.promptPrefsFor(identity({}))).timezone).toBe("UTC");
    expect((await runtime.promptPrefsFor(null)).timezone).toBe("UTC");
  });

  it("reads a run owner's stored profile when the identity carries no preferences", async () => {
    const users = store();
    await users.create({
      id: "usr_a",
      email: "a@example.com",
      displayName: "Ada",
      preferences: { timezone: "Asia/Tokyo", locale: "ja-JP" },
    });
    const runtime = runtimeWith("Pacific/Honolulu", users);
    // A task run acts as `{ id: owner }` and nothing else.
    const prefs = await runtime.promptPrefsFor({ id: "usr_a" } as UserIdentity);
    expect(prefs.timezone).toBe("Asia/Tokyo");
    expect(prefs.locale).toBe("ja-JP");
  });

  it("gives the prompt the effective timezone in the user block and today's date", async () => {
    const runtime = runtimeWith("Pacific/Honolulu", store());
    const prefs = await runtime.promptPrefsFor(identity({}));
    const prompt = composeSystemPrompt([], null, undefined, undefined, undefined, prefs);
    expect(prompt).toContain("- Timezone: Pacific/Honolulu");
    expect(prompt).toMatch(/- Today's date: .+ \(Pacific\/Honolulu\)/);
  });
});
