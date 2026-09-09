import { describe, expect, test } from "bun:test";
import {
  extractToolContracts,
  validateCoreSkill,
  type ToolContract,
} from "../../../scripts/check-core-skill-tool-refs.ts";

const CONTRACTS: ToolContract[] = [
  { source: "nb", name: "search", scopes: ["tools", "catalog"] },
  {
    source: "nb",
    name: "status",
    scopes: ["overview", "connectors", "skills", "config"],
  },
  { source: "automations", name: "create", scopes: [] },
];

describe("check-core-skill-tool-refs — contract extraction", () => {
  test("reads tool names and inline scope enums from static definitions", () => {
    const contracts = extractToolContracts(
      "nb",
      `
        const tools = [
          {
            name: "search",
            description: "Search",
            inputSchema: {
              type: "object",
              properties: {
                scope: { type: "string", enum: ["tools", "catalog"] },
              },
            },
            handler: async () => ({}),
          },
          {
            name: "status",
            description: "Status",
            inputSchema: StatusInput,
            handler: async () => ({}),
          },
        ];
      `,
    );

    expect(contracts).toEqual([
      { source: "nb", name: "search", scopes: ["catalog", "tools"] },
      { source: "nb", name: "status", scopes: [] },
    ]);
  });
});

describe("check-core-skill-tool-refs — prompt validation", () => {
  test("accepts declared tools and the owning tool's scope values", () => {
    const result = validateCoreSkill(
      "src/skills/core/bootstrap.md",
      [
        '- **nb__search** — use `scope: "tools"` or `scope: "catalog"`.',
        '| `automations__create` | Create one |',
      ].join("\n"),
      CONTRACTS,
    );

    expect(result.violations).toEqual([]);
  });

  test("reports an unknown tool with the source's accepted set", () => {
    const result = validateCoreSkill(
      "src/skills/core/bootstrap.md",
      "Call `nb__serch` before promotion.",
      CONTRACTS,
    );

    expect(result.violations).toEqual([
      {
        file: "src/skills/core/bootstrap.md",
        line: 1,
        token: "nb__serch",
        owner: "nb",
        accepted: ["search", "status"],
      },
    ]);
  });

  test("reports an unknown static source", () => {
    const result = validateCoreSkill(
      "src/skills/core/bootstrap.md",
      "Call `retired__tool` before promotion.",
      CONTRACTS,
    );

    expect(result.violations).toEqual([
      {
        file: "src/skills/core/bootstrap.md",
        line: 1,
        token: "retired__tool",
        owner: "static tool source",
        accepted: ["automations", "nb"],
      },
    ]);
  });

  test("reports a rejected scope against the tool that owns it", () => {
    const result = validateCoreSkill(
      "src/skills/core/bootstrap.md",
      'Call `nb__search` with `scope: "registry"`.',
      CONTRACTS,
    );

    expect(result.violations).toEqual([
      {
        file: "src/skills/core/bootstrap.md",
        line: 1,
        token: 'scope: "registry"',
        owner: "nb__search",
        accepted: ["catalog", "tools"],
      },
    ]);
  });

  test("skips placeholders and accepts explicit examples for dynamic connector sources", () => {
    const result = validateCoreSkill(
      "src/skills/core/bootstrap.md",
      "Tools use `source__tool` format (e.g., `synapse-crm__create_contact`).",
      CONTRACTS,
    );

    expect(result.references).toEqual(["synapse-crm__create_contact"]);
    expect(result.violations).toEqual([]);
  });

  test("checks bold-marked declarations, not only backticked ones", () => {
    const result = validateCoreSkill(
      "src/skills/core/bootstrap.md",
      '- **nb__search** — use `scope: "tools"`; **retired__tool** is gone.',
      CONTRACTS,
    );

    expect(result.references).toEqual(["nb__search", "retired__tool", 'scope: "tools"']);
    expect(result.violations).toEqual([
      {
        file: "src/skills/core/bootstrap.md",
        line: 1,
        token: "retired__tool",
        owner: "static tool source",
        accepted: ["automations", "nb"],
      },
    ]);
  });

  test("counts a bold-and-backticked reference once", () => {
    const result = validateCoreSkill(
      "src/skills/core/bootstrap.md",
      "- **`nb__serch`** — promote before calling.",
      CONTRACTS,
    );

    expect(result.references).toEqual(["nb__serch"]);
    expect(result.violations).toHaveLength(1);
  });

  test("a hard-wrapped bullet still owns the scopes on its continuation lines", () => {
    const result = validateCoreSkill(
      "src/skills/core/bootstrap.md",
      ["- **nb__status** — platform status. Use", '  `scope: "connectors"` for health.'].join("\n"),
      CONTRACTS,
    );

    expect(result.violations).toEqual([]);
  });

  test("the owning tool does not carry past a blank line", () => {
    const result = validateCoreSkill(
      "src/skills/core/bootstrap.md",
      ["- **nb__status** — platform status.", "", 'Elsewhere, `scope: "connectors"`.'].join("\n"),
      CONTRACTS,
    );

    expect(result.violations).toEqual([
      {
        file: "src/skills/core/bootstrap.md",
        line: 3,
        token: 'scope: "connectors"',
        owner: "unresolved tool",
        accepted: ["nb__search", "nb__status"],
      },
    ]);
  });
});

describe("check-core-skill-tool-refs — script self-invocation", () => {
  test("the current core skills resolve against current static contracts", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "--no-env-file", "scripts/check-core-skill-tool-refs.ts"],
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(
      /^✓ \d+ distinct tool\/scope references validated across \d+ core skills\n$/,
    );
    expect(stderr).toBe("");
  });
});
