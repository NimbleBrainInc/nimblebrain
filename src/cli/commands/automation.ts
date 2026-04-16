import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { ConsoleEventSink } from "../../adapters/console-events.ts";
import { extractText } from "../../engine/content-helpers.ts";
import { Runtime } from "../../runtime/runtime.ts";
import { loadConfig } from "../config.ts";
import { log } from "../log.ts";

/**
 * Start a headless runtime for CLI tool invocation.
 * Bundles start, tools become available, then we call and shut down.
 */
async function startHeadlessRuntime(configFlag?: string): Promise<Runtime> {
  const config = loadConfig({
    config: configFlag,
    defaultWorkDir: join(homedir(), ".nimblebrain"),
  });
  config.events = [new ConsoleEventSink()];
  return Runtime.start(config);
}

/**
 * Execute a tool via the runtime's tool registry.
 * Returns the parsed JSON result or throws on error.
 */
async function callTool(
  runtime: Runtime,
  toolName: string,
  input: Record<string, unknown> = {},
): Promise<unknown> {
  // CLI uses the first available workspace registry (or _dev in dev mode)
  const registries = runtime.getWorkspaceRegistries();
  const registry = registries.values().next().value;
  if (!registry) throw new Error("No workspace registries available");
  const result = await registry.execute({
    id: `cli_${crypto.randomUUID().slice(0, 8)}`,
    name: toolName,
    input,
  });

  const text = extractText(result.content);
  if (result.isError) {
    throw new Error(text);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createAutomationCommand(): Command {
  const cmd = new Command("automation").description("Manage scheduled automations").action(() => {
    process.stderr.write(cmd.helpInformation());
    process.exit(2);
  });

  // -----------------------------------------------------------------------
  // nb automation list
  // -----------------------------------------------------------------------
  cmd
    .command("list")
    .description("List all automations")
    .action(async (_opts: unknown, subcmd: Command) => {
      const globals = subcmd.optsWithGlobals();
      let runtime: Runtime | undefined;
      try {
        runtime = await startHeadlessRuntime(globals.config);
        const data = (await callTool(runtime, "automations__list")) as {
          automations: Array<{
            name: string;
            enabled: boolean;
            schedule: string;
            source: string;
            lastRunStatus: string | null;
            nextRunAt: string | null;
          }>;
          total: number;
        };

        if (globals.json) {
          process.stdout.write(`${JSON.stringify(data)}\n`);
        } else if (data.automations.length === 0) {
          console.log("No automations configured.");
        } else {
          console.log(
            "NAME                          ENABLED  SCHEDULE                    SOURCE  LAST RUN   NEXT RUN",
          );
          for (const a of data.automations) {
            const name = a.name.padEnd(30);
            const enabled = (a.enabled ? "yes" : "no").padEnd(9);
            const schedule = (a.schedule ?? "").padEnd(28);
            const source = (a.source ?? "").padEnd(8);
            const lastRun = (a.lastRunStatus ?? "-").padEnd(11);
            const nextRun = a.nextRunAt ?? "-";
            console.log(`${name}${enabled}${schedule}${source}${lastRun}${nextRun}`);
          }
          console.log(`\n${data.total} automation(s)`);
        }
      } catch (err) {
        log.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      } finally {
        if (runtime) await runtime.shutdown();
      }
    });

  // -----------------------------------------------------------------------
  // nb automation status [name]
  // -----------------------------------------------------------------------
  cmd
    .command("status")
    .description("Show automation details and run history")
    .argument("<name>", "automation name")
    .action(async (name: string, _opts: unknown, subcmd: Command) => {
      const globals = subcmd.optsWithGlobals();
      let runtime: Runtime | undefined;
      try {
        runtime = await startHeadlessRuntime(globals.config);
        const data = (await callTool(runtime, "automations__status", { name })) as {
          automation: {
            id: string;
            name: string;
            description?: string;
            prompt: string;
            scheduleHuman: string;
            enabled: boolean;
            source: string;
            runCount: number;
            consecutiveErrors: number;
            lastRunAtHuman: string | null;
            nextRunAtHuman: string | null;
            model?: string | null;
            maxIterations?: number;
            skill?: string;
          };
          recentRuns: Array<{
            id: string;
            status: string;
            startedAt: string;
            completedAt?: string;
            iterations: number;
            toolCalls: number;
            error?: string;
            resultPreview?: string;
          }>;
        };

        if (globals.json) {
          process.stdout.write(`${JSON.stringify(data)}\n`);
        } else {
          const a = data.automation;
          console.log(`Name:         ${a.name}`);
          console.log(`ID:           ${a.id}`);
          if (a.description) console.log(`Description:  ${a.description}`);
          console.log(`Enabled:      ${a.enabled ? "yes" : "no"}`);
          console.log(`Schedule:     ${a.scheduleHuman}`);
          console.log(`Source:       ${a.source}`);
          console.log(`Run count:    ${a.runCount}`);
          console.log(`Errors:       ${a.consecutiveErrors} consecutive`);
          console.log(`Last run:     ${a.lastRunAtHuman ?? "never"}`);
          console.log(`Next run:     ${a.nextRunAtHuman ?? "-"}`);
          if (a.model) console.log(`Model:        ${a.model}`);
          if (a.maxIterations) console.log(`Max iters:    ${a.maxIterations}`);
          if (a.skill) console.log(`Skill:        ${a.skill}`);
          console.log(
            `Prompt:       ${a.prompt.slice(0, 120)}${a.prompt.length > 120 ? "..." : ""}`,
          );

          if (data.recentRuns.length > 0) {
            console.log("\nRecent runs:");
            console.log("  ID          STATUS     STARTED                    ITERS  TOOLS");
            for (const r of data.recentRuns) {
              const id = r.id.slice(0, 10).padEnd(12);
              const status = r.status.padEnd(11);
              const started = r.startedAt.padEnd(27);
              const iters = String(r.iterations).padEnd(7);
              const tools = String(r.toolCalls);
              console.log(`  ${id}${status}${started}${iters}${tools}`);
              if (r.error) {
                console.log(`    Error: ${r.error}`);
              }
            }
          } else {
            console.log("\nNo runs yet.");
          }
        }
      } catch (err) {
        log.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      } finally {
        if (runtime) await runtime.shutdown();
      }
    });

  // -----------------------------------------------------------------------
  // nb automation run <name>
  // -----------------------------------------------------------------------
  cmd
    .command("run")
    .description("Trigger an immediate automation run")
    .argument("<name>", "automation name")
    .action(async (name: string, _opts: unknown, subcmd: Command) => {
      const globals = subcmd.optsWithGlobals();
      let runtime: Runtime | undefined;
      try {
        runtime = await startHeadlessRuntime(globals.config);
        const data = (await callTool(runtime, "automations__run", { name })) as {
          run: {
            id: string;
            status: string;
            startedAt: string;
            completedAt?: string;
            iterations: number;
            toolCalls: number;
            error?: string;
            resultPreview?: string;
          };
        };

        if (globals.json) {
          process.stdout.write(`${JSON.stringify(data)}\n`);
        } else {
          const r = data.run;
          console.log(`Run ${r.id}: ${r.status}`);
          console.log(`  Started:    ${r.startedAt}`);
          if (r.completedAt) console.log(`  Completed:  ${r.completedAt}`);
          console.log(`  Iterations: ${r.iterations}`);
          console.log(`  Tool calls: ${r.toolCalls}`);
          if (r.error) {
            console.log(`  Error:      ${r.error}`);
          }
          if (r.resultPreview) {
            console.log(`  Result:     ${r.resultPreview}`);
          }
        }
      } catch (err) {
        log.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      } finally {
        if (runtime) await runtime.shutdown();
      }
    });

  // -----------------------------------------------------------------------
  // nb automation pause <name>
  // -----------------------------------------------------------------------
  cmd
    .command("pause")
    .description("Pause (disable) an automation")
    .argument("<name>", "automation name")
    .action(async (name: string, _opts: unknown, subcmd: Command) => {
      const globals = subcmd.optsWithGlobals();
      let runtime: Runtime | undefined;
      try {
        runtime = await startHeadlessRuntime(globals.config);
        const data = (await callTool(runtime, "automations__update", {
          name,
          enabled: false,
        })) as { automation: { name: string; enabled: boolean }; message: string };

        if (globals.json) {
          process.stdout.write(`${JSON.stringify(data)}\n`);
        } else {
          console.log(`Paused "${data.automation.name}".`);
        }
      } catch (err) {
        log.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      } finally {
        if (runtime) await runtime.shutdown();
      }
    });

  // -----------------------------------------------------------------------
  // nb automation resume <name>
  // -----------------------------------------------------------------------
  cmd
    .command("resume")
    .description("Resume (enable) an automation")
    .argument("<name>", "automation name")
    .action(async (name: string, _opts: unknown, subcmd: Command) => {
      const globals = subcmd.optsWithGlobals();
      let runtime: Runtime | undefined;
      try {
        runtime = await startHeadlessRuntime(globals.config);
        const data = (await callTool(runtime, "automations__update", {
          name,
          enabled: true,
        })) as { automation: { name: string; enabled: boolean }; message: string };

        if (globals.json) {
          process.stdout.write(`${JSON.stringify(data)}\n`);
        } else {
          console.log(`Resumed "${data.automation.name}".`);
        }
      } catch (err) {
        log.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      } finally {
        if (runtime) await runtime.shutdown();
      }
    });

  return cmd;
}
