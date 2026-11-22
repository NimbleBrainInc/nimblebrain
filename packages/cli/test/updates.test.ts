import { describe, expect, test } from "bun:test";
import type { Deps } from "../src/deps.ts";
import { run as runOnly, VERSION } from "../src/main.ts";
import { cachePath, noticeLines } from "../src/updates.ts";
import { type MachineOptions, machine, record } from "./fake.ts";

const HOME = "/home/dana/.nimblebrain-local";
const CACHE = "/home/dana/.cache/nimblebrain/update-check.json";
const INSTALL = record({ version: "0.73.0" });
const HOUR = 60 * 60_000;
/** Newer than any CLI this repo will release soon. */
const LATEST_CLI = "99.0.0";

/** An installed, stopped NimbleBrain v0.73.0 with the update check on. */
function installed(opts: MachineOptions = {}) {
  const m = machine({
    tags: ["v0.73.0", "v0.74.0"],
    npmLatest: LATEST_CLI,
    ...opts,
    env: { NIMBLEBRAIN_NO_UPDATE_CHECK: "", ...opts.env },
    files: { [`${HOME}/install.json`]: INSTALL, ...opts.files },
  });
  const urls: string[] = [];
  const { getJson, getText } = m.deps;
  m.deps.getJson = (url, t) => {
    urls.push(url);
    return getJson(url, t);
  };
  m.deps.getText = (url, t) => {
    urls.push(url);
    return getText(url, t);
  };
  return Object.assign(m, { lookups: () => urls.filter((u) => !u.startsWith("http://127.0.0.1")) });
}

const cache = (ageMs: number, known: { cli?: string; runtime?: string }) =>
  JSON.stringify({ checked_at: Date.now() - ageMs, ...known });

const never = () => new Promise<undefined>(() => {});
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A run as `bin.ts` makes it: the answer, then the notices it waits for after writing it. */
async function run(argv: string[], deps: Deps) {
  const begun = Date.now();
  const answer = await runOnly(argv, deps);
  const answeredIn = Date.now() - begun;
  const stderr = await answer.notices?.();
  return { ...answer, stderr, answeredIn, tookIn: Date.now() - begun };
}

describe("update notices", () => {
  test("a person sees one line each for a newer CLI and runtime, on stderr after the answer", async () => {
    const m = installed();
    const { stdout, stderr, code } = await run(["status"], m.deps);
    expect(code).toBe(0);
    expect(stdout).toContain("NimbleBrain v0.73.0");
    expect(stdout).not.toContain("is available");
    expect(stderr).toBe(
      `nimblebrain ${LATEST_CLI} is available (you have ${VERSION}): npx nimblebrain@latest\n` +
        "NimbleBrain v0.74.0 is available (you have v0.73.0): npx nimblebrain update\n",
    );
  });

  test("nothing newer, or nothing known, prints no notice", async () => {
    const same = installed({ tags: ["v0.73.0"], npmLatest: VERSION });
    expect((await run(["status"], same.deps)).stderr).toBeUndefined();
    const unknown = installed({ tags: [], npmLatest: undefined });
    const res = await run(["status", "--json"], unknown.deps);
    expect(res.stderr).toBeUndefined();
    expect(JSON.parse(res.stdout).updates).toBeUndefined();
  });

  test("the runtime line only where it helps; the CLI line on any command", async () => {
    const m = installed();
    const { stderr } = await run(["logs"], m.deps);
    expect(stderr).toContain(`nimblebrain ${LATEST_CLI} is available`);
    expect(stderr).not.toContain("NimbleBrain v0.74.0");
  });

  test("JSON carries updates on a status answer, both sides, and no notice", async () => {
    const m = installed({ files: { [CACHE]: cache(HOUR, { cli: "0.0.1", runtime: "v0.74.0" }) } });
    const { stdout, stderr } = await run(["status", "--json"], m.deps);
    expect(stderr).toBeUndefined();
    expect(JSON.parse(stdout).updates).toEqual({
      cli: { current: VERSION, latest: "0.0.1" },
      runtime: { current: "0.73.0", latest: "0.74.0" },
    });
  });

  test("JSON omits a side the cache does not know, and answers without state carry none", async () => {
    const m = installed({ files: { [CACHE]: cache(HOUR, { runtime: "v0.74.0" }) } });
    const status = JSON.parse((await run(["status", "--json"], m.deps)).stdout);
    expect(status.updates).toEqual({ runtime: { current: "0.73.0", latest: "0.74.0" } });
    const logs = JSON.parse((await run(["logs", "--json"], m.deps)).stdout);
    expect(logs.updates).toBeUndefined();
  });

  test("a cache younger than a day is used without a lookup", async () => {
    const m = installed({ files: { [CACHE]: cache(23 * HOUR, { cli: LATEST_CLI }) } });
    const { stderr } = await run(["status"], m.deps);
    expect(m.lookups()).toEqual([]);
    expect(stderr).toContain(`nimblebrain ${LATEST_CLI} is available`);
  });

  test("a cache older than a day is looked up again and rewritten", async () => {
    const m = installed({ files: { [CACHE]: cache(25 * HOUR, { cli: "0.0.1" }) } });
    await run(["status"], m.deps);
    expect(m.lookups()).toHaveLength(2);
    const written = JSON.parse(m.files.get(CACHE)?.text ?? "{}");
    expect(written).toMatchObject({ cli: LATEST_CLI, runtime: "v0.74.0" });
    expect(Date.now() - written.checked_at).toBeLessThan(HOUR);
    // The next run, within the day, looks nothing up.
    await run(["status"], m.deps);
    expect(m.lookups()).toHaveLength(2);
  });

  test("a failed lookup changes nothing and leaves the old cache", async () => {
    const old = cache(25 * HOUR, { cli: LATEST_CLI });
    const m = installed({ tags: [], npmLatest: undefined, files: { [CACHE]: old } });
    const { stderr } = await run(["status"], m.deps);
    expect(m.files.get(CACHE)?.text).toBe(old);
    expect(stderr).toContain(`nimblebrain ${LATEST_CLI} is available`);
  });

  test("a hanging lookup never delays the answer; the run waits at most a second after it", async () => {
    for (const argv of [["status"], ["status", "--json"]]) {
      const m = installed({ files: { [CACHE]: cache(25 * HOUR, { cli: LATEST_CLI }) } });
      m.deps.getJson = async (url, t) =>
        url.startsWith("https://registry.npmjs.org/") ? never() : machine().deps.getJson(url, t);
      m.deps.getText = async () => never();
      m.deps.sleep = realSleep;
      const res = await run(argv, m.deps);
      expect(res.answeredIn).toBeLessThan(300);
      expect(res.tookIn).toBeGreaterThanOrEqual(900);
      expect(res.tookIn).toBeLessThan(1_500);
      if (argv.includes("--json")) {
        expect(res.stderr).toBeUndefined();
        expect(JSON.parse(res.stdout).updates.cli).toEqual({
          current: VERSION,
          latest: LATEST_CLI,
        });
      } else {
        expect(res.stderr).toContain(`nimblebrain ${LATEST_CLI} is available`);
      }
    }
  });

  test("a --json run on a stale cache answers from it, then lets the lookup rewrite it", async () => {
    const m = installed({ files: { [CACHE]: cache(25 * HOUR, { cli: "0.0.1" }) } });
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { getJson } = m.deps;
    m.deps.getJson = async (url, t) => {
      if (url.startsWith("https://registry.npmjs.org/")) await gate;
      return getJson(url, t);
    };
    m.deps.sleep = realSleep;
    const answer = await runOnly(["status", "--json"], m.deps);
    expect(JSON.parse(answer.stdout).updates.cli.latest).toBe("0.0.1");
    setTimeout(release, 100);
    expect(await answer.notices?.()).toBeUndefined();
    expect(JSON.parse(m.files.get(CACHE)?.text ?? "{}").cli).toBe(LATEST_CLI);
  });

  test("CI, NIMBLEBRAIN_NO_UPDATE_CHECK=1 and DO_NOT_TRACK=1 each turn it off", async () => {
    for (const env of [
      { CI: "true" },
      { NIMBLEBRAIN_NO_UPDATE_CHECK: "1" },
      { DO_NOT_TRACK: "1" },
    ]) {
      const m = installed({ env, files: { [CACHE]: cache(HOUR, { cli: LATEST_CLI }) } });
      const human = await run(["status"], m.deps);
      const agent = JSON.parse((await run(["status", "--json"], m.deps)).stdout);
      expect(human.stderr).toBeUndefined();
      expect(agent.updates).toBeUndefined();
      expect(m.lookups()).toEqual([]);
    }
  });

  test("help and --version look nothing up", async () => {
    const m = installed();
    await run(["--help"], m.deps);
    await run(["--version"], m.deps);
    expect(m.lookups()).toEqual([]);
  });

  test("the cache is shared by every home, in the per-user cache folder", () => {
    const m = installed();
    expect(cachePath(m.deps)).toBe(CACHE);
    m.deps.env = { ...m.deps.env, XDG_CACHE_HOME: "/var/cache/dana" };
    expect(cachePath(m.deps)).toBe("/var/cache/dana/nimblebrain/update-check.json");
  });
});

describe("noticeLines", () => {
  const updates = {
    cli: { current: "0.3.0", latest: "0.3.1" },
    runtime: { current: "0.76.0", latest: "0.77.0" },
  };

  test("the runtime line names the install the run acted on, so update reaches it", () => {
    const lines = noticeLines(updates, true, "npx nimblebrain --home /home/dana/nb-try");
    expect(lines).toContain(
      "NimbleBrain v0.77.0 is available (you have v0.76.0): npx nimblebrain --home /home/dana/nb-try update",
    );
    // A newer CLI is the same for every install, so its line carries no home.
    expect(lines).toContain(
      "nimblebrain 0.3.1 is available (you have 0.3.0): npx nimblebrain@latest",
    );
  });

  test("the default install's runtime line is the bare command", () => {
    expect(noticeLines(updates, true)).toContain(
      "NimbleBrain v0.77.0 is available (you have v0.76.0): npx nimblebrain update",
    );
  });
});
