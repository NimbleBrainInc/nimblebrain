import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, FLAG_SPECS, MCP_SUBCOMMANDS, parse } from "../src/args.ts";
import { run, VERSION } from "../src/main.ts";
import { ERRORS } from "../src/result.ts";
import { machine } from "./fake.ts";

interface Help {
  ok: true;
  cli_version: string;
  commands: Array<{ name: string; args: string[]; description: string }>;
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
      const value = f.name === "--port" ? "27300" : f.name === "--telemetry" ? "on" : "none";
      expect(() => parse(f.takes ? [f.name, value] : [f.name])).not.toThrow();
      for (const c of f.commands ?? []) expect(commandNames).toContain(c);
    }
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
