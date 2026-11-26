import { describe, expect, test } from "bun:test";
import { agentAnswer, defaultAgent, detectAgents, pickAgent } from "../src/agent-picker.ts";
import { run } from "../src/main.ts";
import { CLAUDE_MAX, type MachineOptions, machine, ok } from "./fake.ts";

const env = { NIMBLEBRAIN_TAG: "v0.73.0" };
const CURSOR = "/home/dana/.cursor/argv.json";
const CLAUDE_ADD = "claude mcp add --transport http -s user nimblebrain";
const CODEX_ADD = "codex mcp add nimblebrain";

/** A Mac with Claude Code and Codex signed in to their plans, and nothing installed yet. */
const mac = (opts: MachineOptions = {}) =>
  machine({
    platform: "darwin",
    env,
    interactive: true,
    programs: ["claude", "codex"],
    exec: {
      "claude auth status --json": ok(CLAUDE_MAX),
      "codex login status": ok("Logged in using ChatGPT\n"),
    },
    ...opts,
  });

/** Linux, where the model is a key: confirm, source, provider, key, then the agent. */
const linux = (agent: string, opts: MachineOptions = {}) =>
  machine({ env, interactive: true, answers: ["", "", "", "sk-typed", agent], ...opts });

const connected = (m: ReturnType<typeof machine>) => ({
  claude: m.calls.some((c) => c.includes(CLAUDE_ADD)),
  codex: m.calls.some((c) => c.includes(CODEX_ADD)),
  cursor: m.files.get("/home/dana/.cursor/mcp.json")?.text.includes("nimblebrain") ?? false,
});

describe("connecting a coding agent at init", () => {
  test("lists the installed agents first, and Enter takes the one that also runs NimbleBrain's agents", async () => {
    // Start, the model source (Enter: the Claude subscription), the agent (Enter).
    const m = mac({ answers: ["", "", ""] });
    const { code } = await run([], m.deps);
    expect(code).toBe(0);
    const at = m.said.indexOf("Connect a coding agent to NimbleBrain?");
    expect(m.said.slice(at, at + 6)).toEqual([
      "Connect a coding agent to NimbleBrain?",
      "It can then use NimbleBrain's tools. It does not change what runs NimbleBrain's own agents.",
      "  1) Claude Code   (installed; also runs NimbleBrain's agents)",
      "  2) Codex         (installed)",
      "  3) Cursor",
      "  4) None",
    ]);
    expect(m.asked.at(-1)).toBe("Choose 1-4, or claude-code, codex, cursor, none [1]: ");
    expect(connected(m)).toEqual({ claude: true, codex: false, cursor: false });
  });

  test("on Codex, the default is Codex", async () => {
    const m = mac({ answers: ["", "2", ""] });
    expect((await run([], m.deps)).code).toBe(0);
    expect(m.said).toContain("  2) Codex         (installed; also runs NimbleBrain's agents)");
    expect(m.asked.at(-1)).toBe("Choose 1-4, or claude-code, codex, cursor, none [2]: ");
    expect(connected(m)).toEqual({ claude: false, codex: true, cursor: false });
  });

  test("with only Cursor here, Cursor is first and the default", async () => {
    const m = linux("", { files: { [CURSOR]: "{}" } });
    expect((await run([], m.deps)).code).toBe(0);
    expect(m.said).toContain("  1) Cursor        (installed)");
    expect(m.asked.at(-1)).toBe("Choose 1-4, or cursor, claude-code, codex, none [1]: ");
    expect(connected(m)).toEqual({ claude: false, codex: false, cursor: true });
  });

  test("with no agent here, the default is None and Enter connects nothing", async () => {
    const m = linux("");
    const { stdout, code } = await run([], m.deps);
    expect(code).toBe(0);
    expect(m.asked.at(-1)).toBe("Choose 1-4, or claude-code, cursor, codex, none [4]: ");
    expect(connected(m)).toEqual({ claude: false, codex: false, cursor: false });
    expect(stdout).not.toContain("can use NimbleBrain's tools");
  });

  test("an agent that is not installed can still be chosen by name", async () => {
    const m = linux("claude");
    expect((await run([], m.deps)).code).toBe(0);
    expect(connected(m).claude).toBe(true);
  });

  test("an answer that names no agent is asked again, never taken as none", async () => {
    const m = linux("vim", {
      answers: ["", "", "", "sk-typed", "vim", "2"],
      files: { [CURSOR]: "{}" },
    });
    expect((await run([], m.deps)).code).toBe(0);
    expect(m.said).toContain('"vim" is not one of them. Type a number from 1 to 4, or a name.');
    expect(m.asked.filter((q) => q.startsWith("Choose 1-4, or cursor"))).toHaveLength(2);
    // 2) is Claude Code, after the installed Cursor.
    expect(connected(m)).toEqual({ claude: true, codex: false, cursor: false });
  });

  test("three answers that name no agent take the default, and say so", async () => {
    const m = linux("x", {
      answers: ["", "", "", "sk-typed", "x", "y", "z"],
      files: { [CURSOR]: "{}" },
    });
    expect((await run([], m.deps)).code).toBe(0);
    expect(m.said).toContain("Taking the default: 1) Cursor.");
    expect(connected(m).cursor).toBe(true);
  });

  test("--agent decides, and nothing is asked", async () => {
    const m = mac({ answers: ["", ""] });
    expect((await run(["--agent", "codex"], m.deps)).code).toBe(0);
    expect(m.asked.some((q) => q.includes("claude-code"))).toBe(false);
    expect(connected(m)).toEqual({ claude: false, codex: true, cursor: false });
  });

  test("under --yes, --json or no terminal, no agent is chosen for the person", async () => {
    for (const [argv, interactive] of [
      [["--yes"], true],
      [["--json"], true],
      [[], false],
    ] as const) {
      const m = mac({ interactive });
      const { code } = await run([...argv], m.deps);
      expect(code).toBe(0);
      expect(m.asked.some((q) => q.includes("claude-code"))).toBe(false);
      expect(connected(m)).toEqual({ claude: false, codex: false, cursor: false });
    }
  });
});

describe("the agent picker", () => {
  const here = (programs: string[], files: Record<string, string> = {}) =>
    machine({ programs, files }).deps;

  test("accepts a number, the name, the label, and short names, in any case", async () => {
    const options = await detectAgents(here(["claude", "codex"]), "claude");
    expect(options.map((o) => o.agent)).toEqual(["claude-code", "codex", "cursor", "none"]);
    for (const [answer, agent] of [
      ["1", "claude-code"],
      ["3", "cursor"],
      ["4", "none"],
      ["claude-code", "claude-code"],
      ["claude", "claude-code"],
      ["Claude Code", "claude-code"],
      ["CLAUDE", "claude-code"],
      [" codex ", "codex"],
      ["Cursor", "cursor"],
      ["none", "none"],
      ["no", "none"],
    ] as const) {
      expect(agentAnswer(answer, options)).toBe(agent);
    }
    for (const answer of ["0", "5", "vim", "claud", "yes"]) {
      expect(agentAnswer(answer, options)).toBeUndefined();
    }
  });

  test("the default follows the source, else the first installed agent, else None", async () => {
    const both = here(["claude", "codex"]);
    expect(defaultAgent(await detectAgents(both, "claude"), "claude")).toBe("claude-code");
    expect(defaultAgent(await detectAgents(both, "codex"), "codex")).toBe("codex");
    expect(defaultAgent(await detectAgents(both, "api"), "api")).toBe("claude-code");
    // The source's agent is not installed: the first one that is.
    const codexOnly = here(["codex"]);
    expect(defaultAgent(await detectAgents(codexOnly, "claude"), "claude")).toBe("codex");
    const cursor = here([], { [CURSOR]: "{}" });
    expect(defaultAgent(await detectAgents(cursor, "local"), "local")).toBe("cursor");
    expect(defaultAgent(await detectAgents(here([]), null), null)).toBe("none");
  });

  test("Enter takes the default", async () => {
    const m = machine({ programs: ["codex"], answers: [""] });
    const options = await detectAgents(m.deps, "codex");
    expect(await pickAgent(m.deps, options, "codex")).toBe("codex");
  });
});
