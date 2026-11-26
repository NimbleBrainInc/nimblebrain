import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ANSWER_FIELDS } from "../src/answers.ts";
import { COMMANDS, FLAG_SPECS, MCP_SUBCOMMANDS, parse } from "../src/args.ts";
import { run, VERSION } from "../src/main.ts";
import { ERRORS } from "../src/result.ts";
import {
  CLAUDE_MAX,
  LOCAL_COMPOSE,
  type Machine,
  machine,
  ok,
  REPO_COMPOSE,
  record,
} from "./fake.ts";

interface Help {
  ok: true;
  cli_version: string;
  commands: Array<{
    name: string;
    args: string[];
    description: string;
    answer: Record<string, string>;
  }>;
  flags: Array<{ name: string; takes: string | null; description: string; commands?: string[] }>;
  errors: Array<{ code: string; fix: string; exit: number }>;
}

async function helpJson(argv: string[]): Promise<Help> {
  const { stdout, code } = await run(argv, machine().deps);
  expect(code).toBe(0);
  return JSON.parse(stdout) as Help;
}

/** Every error code the source raises: `new CliError("X"` anywhere, and the runtime's codes `mcp` passes on. */
function raisedCodes(): string[] {
  const dir = join(import.meta.dir, "../src");
  const codes = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const m of text.matchAll(/CliError\(\s*"([A-Z_]+)"/g)) codes.add(m[1] ?? "");
    const runtime = text.match(/const RUNTIME_CODES = \[([^\]]*)\]/)?.[1] ?? "";
    for (const m of runtime.matchAll(/"([A-Z_]+)"/g)) codes.add(m[1] ?? "");
  }
  return [...codes].sort();
}

describe("help --json", () => {
  test("help --json and --help --json answer the same description", async () => {
    const a = await helpJson(["help", "--json"]);
    expect(a).toMatchObject({ ok: true, cli_version: VERSION });
    expect(await helpJson(["--help", "--json"])).toEqual(a);
  });

  test("names every command and mcp subcommand the parser accepts, and each parses", async () => {
    const help = await helpJson(["help", "--json"]);
    const names = help.commands.map((c) => c.name);
    for (const cmd of COMMANDS.filter((c) => c !== "mcp")) expect(names).toContain(cmd);
    for (const sub of Object.keys(MCP_SUBCOMMANDS)) expect(names).toContain(`mcp ${sub}`);
    expect(names).toContain("help");
    for (const c of help.commands) {
      const argv = [
        ...c.name.split(" "),
        ...c.args.filter((a) => a.startsWith("<")).map(() => "x"),
      ];
      expect(() => parse(argv)).not.toThrow();
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  test("names every flag the parser takes, each with what it takes, and each parses", async () => {
    const help = await helpJson(["help", "--json"]);
    const names = help.flags.map((f) => f.name);
    expect(names.sort()).toEqual(
      Object.keys(FLAG_SPECS)
        .map((f) => `--${f}`)
        .sort(),
    );
    const commandNames = help.commands.map((c) => c.name);
    for (const f of help.flags) {
      const value =
        f.name === "--port"
          ? "27300"
          : f.name === "--telemetry"
            ? "on"
            : f.name === "--use"
              ? "api"
              : "none";
      expect(() => parse(f.takes ? [f.name, value] : [f.name])).not.toThrow();
      for (const c of f.commands ?? []) expect(commandNames).toContain(c);
    }
  });

  test("describes each command's answer, field by field, from ANSWER_FIELDS", async () => {
    const help = await helpJson(["help", "--json"]);
    for (const c of help.commands) {
      expect(c.answer).toEqual(ANSWER_FIELDS[c.name as keyof typeof ANSWER_FIELDS]);
      expect(Object.keys(c.answer).length).toBeGreaterThan(0);
      for (const description of Object.values(c.answer))
        expect(description.length).toBeGreaterThan(0);
    }
    expect(Object.keys(ANSWER_FIELDS).sort()).toEqual(help.commands.map((c) => c.name).sort());
  });

  test("every field a command answers is one help --json describes", async () => {
    // The type-check holds each builder to ANSWER_FIELDS; this runs the commands to catch a cast that hides a field.
    const home = "/home/dana/.nimblebrain-local";
    const help = await helpJson(["help", "--json"]);
    const answers = async (argv: string[], m: Machine) => {
      const { stdout } = await run([...argv, "--json"], m.deps);
      const body = JSON.parse(stdout) as Record<string, unknown>;
      expect({ argv, body }).toMatchObject({ argv, body: { ok: true } });
      const name = argv[0] === "mcp" ? `mcp ${argv[1]}` : (argv[0] ?? "");
      const described = Object.keys(help.commands.find((c) => c.name === name)?.answer ?? {});
      const answered = Object.keys(body).filter((k) => k !== "ok");
      expect({ name, undescribed: answered.filter((k) => !described.includes(k)) }).toEqual({
        name,
        undescribed: [],
      });
      return answered;
    };
    // `key` asks a person for the key even with --json; nothing else here asks.
    const m = machine({
      interactive: true,
      answers: ["openai", "sk-openai"],
      env: { NIMBLEBRAIN_TAG: "v0.73.0" },
      workspaceToolCall: (_ws, call) => ({
        status: 200,
        body: {
          structuredContent:
            call.arguments.action === "install"
              ? { serverName: "notes", url: "u", dialed: "d", placements: [], warning: "w" }
              : { installed: [{ serverName: "notes", url: "u", status: "connected" }] },
        },
      }),
      files: {
        [`${home}/install.json`]: record({ phase: "starting" }),
        [`${home}/.env`]: "ANTHROPIC_API_KEY=sk-test\n",
      },
    });
    const runs: string[][] = [
      ["doctor"],
      ["init", "--yes", "--agent", "none"],
      ["key"],
      ["status"],
      ["open"],
      ["up"],
      ["logs"],
      ["telemetry"],
      ["mcp", "add", "http://127.0.0.1:8000/mcp"],
      ["mcp", "list"],
      ["mcp", "remove", "notes"],
      ["update"],
      ["down"],
      ["uninstall", "--yes"],
      ["help"],
    ];
    for (const argv of runs) await answers(argv, m);
    expect(
      new Set([...runs.map((a) => (a[0] === "mcp" ? `mcp ${a[1]}` : a[0])), "local-model", "use"]),
    ).toEqual(new Set(help.commands.map((c) => c.name)));

    // On a local model: Ollama installed but down, so each command that starts it says so.
    const local = machine({
      env: { NIMBLEBRAIN_TAG: "v0.73.0" },
      compose: { status: 200, body: LOCAL_COMPOSE },
      platform: "darwin",
      files: { "/Applications/Ollama.app/Contents/Info.plist": "<plist/>" },
      ollama: {
        down: "until-started",
        models: { "gemma4:e4b": { capabilities: ["completion", "tools"] } },
      },
    });
    expect(await answers(["init", "--yes", "--local-model", "gemma4:e4b"], local)).toContain(
      "ollama_started",
    );
    local.ollamaUp = false;
    expect(await answers(["local-model", "gemma4:e4b"], local)).toContain("ollama_started");
    // doctor with --json never starts Ollama, so its local checks answer without ollama_started.
    await answers(["doctor"], local);

    // On a Mac signed in to a Claude subscription, with a key and Ollama, `use` answers each source.
    const sub = machine({
      platform: "darwin",
      exec: { "claude auth status --json": ok(CLAUDE_MAX) },
      ollama: { models: { "gemma4:e4b": { capabilities: ["completion", "tools"] } } },
      files: {
        [`${home}/install.json`]: record(),
        [`${home}/.env`]: "ANTHROPIC_API_KEY=sk-test\n",
        [`${home}/docker-compose.yml`]: REPO_COMPOSE,
      },
    });
    const base = ["model_source", "agent_runtime"];
    expect(await answers(["use", "claude"], sub)).toEqual([...base, "billed_to", "tools"]);
    expect(await answers(["use", "api"], sub)).toEqual([...base, "provider"]);
    expect(await answers(["use", "local"], sub)).toEqual([...base, "local_model"]);
    sub.ollamaUp = false;
    sub.files.set("/Applications/Ollama.app/Contents/Info.plist", {
      text: "<plist/>",
      mode: 0o644,
    });
    expect(await answers(["use", "local"], sub)).toContain("ollama_started");
  });

  test("lists every error code the CLI raises, with its fix and exit code", async () => {
    const help = await helpJson(["help", "--json"]);
    const codes = help.errors.map((e) => e.code);
    expect(codes.sort()).toEqual(Object.keys(ERRORS).sort());
    for (const code of raisedCodes()) expect(codes).toContain(code);
    for (const e of help.errors) {
      expect(e.fix).toBe(ERRORS[e.code as keyof typeof ERRORS]);
      expect(e.exit).toBe(e.code === "USAGE" ? 2 : 1);
    }
  });

  test("--help shows the same commands and flags as lines", async () => {
    const help = await helpJson(["help", "--json"]);
    const { stdout } = await run(["--help"], machine().deps);
    for (const c of help.commands) expect(stdout).toContain([c.name, ...c.args].join(" "));
    for (const f of help.flags) expect(stdout).toContain(f.name);
    expect(stdout).toContain("help --json");
  });
});
