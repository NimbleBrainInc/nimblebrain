import { describe, expect, test } from "bun:test";
import { run } from "../src/main.ts";
import { browserCommand } from "../src/open.ts";
import { machine, record } from "./fake.ts";

const HOME = "/home/dana/.nimblebrain-local";
const ENV = `${HOME}/.env`;
/** A home whose first start did not finish, with a key entered since: `init` resumes it. */
const STARTING = { [`${HOME}/install.json`]: record({ phase: "starting" }) };
const URL = "http://127.0.0.1:27246";
const env = { NIMBLEBRAIN_TAG: "v0.73.0" };

async function json(argv: string[], m: ReturnType<typeof machine>) {
  const { stdout, code } = await run([...argv, "--json"], m.deps);
  return { body: JSON.parse(stdout), code };
}

/** A machine with a running install made by an agent's `init`, which opens nothing. */
async function running(opts: Parameters<typeof machine>[0] = {}) {
  const m = machine({ env, files: { ...STARTING, [ENV]: "ANTHROPIC_API_KEY=sk-test\n" }, ...opts });
  m.deps.env = { ...m.deps.env, ...env, ...opts.env };
  await json(["--yes", "--agent", "none"], m);
  expect(m.launched).toEqual([]);
  return m;
}

describe("the browser opener", () => {
  const at = (platform: NodeJS.Platform, e: NodeJS.ProcessEnv = {}) =>
    browserCommand({ platform, env: e }, URL);

  test("is the platform's own, with the URL as its own argument", () => {
    expect(at("darwin")).toEqual({ cmd: "open", args: [URL] });
    expect(at("linux", { DISPLAY: ":0" })).toEqual({ cmd: "xdg-open", args: [URL] });
    expect(at("linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual({
      cmd: "xdg-open",
      args: [URL],
    });
  });

  test("is none where no browser can reach the person: no display, SSH, or an unsupported platform", () => {
    expect(at("linux")).toBeUndefined();
    expect(at("darwin", { SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22" })).toBeUndefined();
    expect(at("linux", { DISPLAY: ":0", SSH_TTY: "/dev/pts/0" })).toBeUndefined();
    expect(at("win32")).toBeUndefined();
  });
});

describe("open", () => {
  test("opens the install's URL and answers it", async () => {
    const m = await running();
    expect(await json(["open"], m)).toEqual({
      body: { ok: true, url: URL, opened: true },
      code: 0,
    });
    expect(m.launched).toEqual([`xdg-open ${URL}`]);
  });

  test("on macOS it runs open", async () => {
    const m = await running({ platform: "darwin" });
    await json(["open"], m);
    expect(m.launched).toEqual([`open ${URL}`]);
  });

  test("an opener that fails is opened: false with the URL, never an error", async () => {
    const m = await running({ launch: false });
    expect(await json(["open"], m)).toEqual({
      body: { ok: true, url: URL, opened: false },
      code: 0,
    });
  });

  test("with no display it starts nothing and hands back the URL", async () => {
    const m = await running();
    m.deps.env = { ...m.deps.env, DISPLAY: undefined };
    expect((await json(["open"], m)).body).toEqual({ ok: true, url: URL, opened: false });
    expect(m.launched).toEqual([]);
  });

  test("a person reads the URL either way", async () => {
    const m = await running();
    expect((await run(["open"], m.deps)).stdout).toBe(`  Opened ${URL} in your browser.\n`);
    m.deps.env = { ...m.deps.env, DISPLAY: undefined };
    expect((await run(["open"], m.deps)).stdout).toContain(`Open ${URL} in your browser`);
  });

  test("a stopped runtime is NOT_RUNNING, and open does not start it", async () => {
    const m = await running();
    await json(["down"], m);
    const calls = m.calls.length;
    const { body, code } = await json(["open"], m);
    expect(code).toBe(1);
    expect(body).toMatchObject({ ok: false, error: "NOT_RUNNING", url: URL });
    expect(body.fix).toContain("npx nimblebrain up");
    expect(m.calls.slice(calls)).toEqual([]);
    expect(m.launched).toEqual([]);
  });

  test("no install is NOT_INSTALLED", async () => {
    const m = machine({ env });
    expect((await json(["open"], m)).body.error).toBe("NOT_INSTALLED");
    expect(m.launched).toEqual([]);
  });

  test("--home opens that install, and its fix names that home", async () => {
    const other = "/home/dana/nb-rc";
    const m = machine({
      env,
      files: {
        [`${other}/install.json`]: record({ phase: "starting", port: 27300 }),
        [`${other}/.env`]: "ANTHROPIC_API_KEY=sk\n",
      },
    });
    await json(["--yes", "--agent", "none", "--home", other, "--port", "27300"], m);
    expect((await json(["open", "--home", other], m)).body.url).toBe("http://127.0.0.1:27300");
    expect(m.launched).toEqual(["xdg-open http://127.0.0.1:27300"]);
    await json(["down", "--home", other], m);
    expect((await json(["open", "--home", other], m)).body.fix).toContain(
      `npx nimblebrain --home ${other} up`,
    );
  });
});

describe("init opens the browser", () => {
  const person = (extra: Parameters<typeof machine>[0] = {}) =>
    machine({ env, interactive: true, answers: ["", "", "", "sk-typed", "none"], ...extra });

  test("for a person at the terminal once a fresh install is up, naming the URL", async () => {
    const m = person();
    const { stdout, code } = await run([], m.deps);
    expect(code).toBe(0);
    expect(m.launched).toEqual([`xdg-open ${URL}`]);
    expect(stdout).toContain(`Next: use NimbleBrain in your browser at ${URL}.`);
  });

  test("when no browser opened, the next step says to open the URL", async () => {
    const m = person({ launch: false });
    expect((await run([], m.deps)).stdout).toContain(`Next: open ${URL}.`);
  });

  test("never with --no-open, --json or no terminal", async () => {
    const noOpen = person();
    expect((await run(["--no-open"], noOpen.deps)).stdout).toContain(`Next: open ${URL}.`);
    expect(noOpen.launched).toEqual([]);

    const asJson = person({ files: { ...STARTING, [ENV]: "ANTHROPIC_API_KEY=sk\n" } });
    const { body } = await json(["--agent", "none"], asJson);
    expect(body.ok).toBe(true);
    expect(body.opened).toBeUndefined();
    expect(asJson.launched).toEqual([]);

    const agent = machine({ env, files: { ...STARTING, [ENV]: "ANTHROPIC_API_KEY=sk\n" } });
    await run(["--agent", "none"], agent.deps);
    expect(agent.launched).toEqual([]);
  });

  test("never on a rerun, or when it ends without a model key", async () => {
    const m = person();
    await run([], m.deps);
    await run([], m.deps);
    expect(m.launched).toHaveLength(1);

    // `--yes` at a terminal skips the key prompt: init succeeds, and names the model step instead of opening chat.
    const noKey = machine({ env, interactive: true });
    const { stdout, code } = await run(["--yes", "--agent", "none"], noKey.deps);
    expect(code).toBe(0);
    expect(stdout).not.toContain("error:");
    expect(stdout).toContain("Next: choose what runs NimbleBrain's agents so it can chat.");
    expect(noKey.launched).toEqual([]);
  });
});
