# Execution

Scope: `src/execution/`, the agent runtimes a run executes on. The door that decides a run is `Runtime.startRun` (`src/runtime/AGENTS.md`); why the two are split is ADR-0056.

## The seam

- **The door decides; a runtime executes.** `AgentRuntime.execute(run, io)` receives a `ResolvedRun` (prompt, history, tools, model, limits, signal) and a `RunIO` (the run's walled `ToolRouter` and its `EventSink`). A runtime never resolves tools, skills, models, identity or history itself, and may narrow what a run allows, never widen it.
- **The seam carries NimbleBrain types only.** No ACP, Goose or other vendor type appears in `types.ts`, `registry.ts` or anything `src/runtime/` imports. A protocol is translated at its runtime's own edge.
- **One event vocabulary.** Every runtime emits `EngineEventPayloads` events stamped with `ResolvedRun.runId`, and each run emits one `execution.bound` naming the runtime (and its own session id, when it has one). The conversation log and the browser stream read nothing else, which is why a conversation can move between runtimes.
- **No agent runs as a child of the runtime.** A runtime reaches its agent in this process (the reference agent) or outside the installation over a remote transport, never by spawning one: a child shares the runtime's uid, network and secrets, and an agent with its own loop is the riskiest extension there is. `biome-plugins/no-agent-process.grit` and a `node:child_process` import ban enforce it here. Goose's driver and the stdio process helper live in `test/helpers/acp/` for the live eval only.
- **Capabilities are declared, and the door refuses mismatches.** A runtime states what it holds (`RuntimeCapabilities`); `Runtime.agentRuntimeFor` refuses a run it cannot hold (spend accounts or an input-token cap on a runtime with no spend gate). Never branch on a runtime's id anywhere outside `registry.ts`.
- **Layering:** `execution/` must not import `runtime/`, `tools/` or `platform/` (biome `noRestrictedImports`). It reaches the platform only through `RunIO`.

## ACP (`acp/`)

- **The generic runtime names no agent.** `acp-runtime.ts` knows ACP v1; everything one agent needs beyond it is an `AcpDriver` (`driver.ts`): how to open it (and the working directory the connection owns), whether its tools are the projection alone (`toolSurface`), its `session/new` `_meta` (given the session's MCP servers, for an agent that restates them in its own terms), its own session preparation, its prompt. A new ACP agent is a new driver plus a case in `registry.ts`. If a driver needs a hook the interface lacks, change the interface for every driver, not the runtime for one.
- **One run, one connection, one session.** The door owns the conversation, so every execution opens a fresh session from the history it is handed. No agent-side session is the record of anything.
- **Tools reach the agent through the tool projection only** (`tool-projection.ts`): a loopback MCP endpoint over the run's router, random port, path and bearer, closed with the run. It applies the engine's call checks and the run's `beforeToolCall` / `afterToolCall` hooks, and it emits `tool.start` / `tool.done`. The agent's own `tool_call` updates are logged, never recorded. Never point an agent at `/mcp/<wsId>`: that is a person's attended surface, not a run's bound.
- **The client advertises no `fs` and no `terminal`.** A permission request is allowed when the driver declares `toolSurface: "projection"` (the agent has no tool of its own, and the projection re-checks the call), and otherwise only when its title names a projected tool. ACP has no field that names a tool reliably, so never widen the title match.
- **An agent's own session id is meaningful to that runtime only.** With a fresh store per run it can repeat across runs; never key anything on it.
- **Reasoning streams, it does not persist.** `agent_thought_chunk` becomes `reasoning.delta`, which the conversation store does not keep.

## The reference agent (`acp-agent/`)

NimbleBrain's own engine served as an ACP agent, driven by `acp/drivers/nimblebrain.ts`. It is how the ACP path is tested with no external dependency: `test/integration/execution/runtime-parity.test.ts` runs the same resolved run through the native runtime and through it, and requires the same record. A change to either runtime keeps that test passing; a new runtime joins it.

- **It is the seed of Reflex, a standalone ACP agent.** Keep it extractable: it imports the engine, `acp/nimblebrain-extension.ts` and nothing else of the platform, and reaches tools only through the MCP servers named at `session/new`.
- **It works over plain ACP.** With its driver's `_meta` it takes the door's prompt, history and limits whole; without it, it runs on its own `defaults` and reads whatever context the prompt carries. The parity test drives it both ways, so the transcript path every other agent takes is held to the native record.
- **The `_meta` keys in `nimblebrain-extension.ts` are this driver's wire format with its own agent**, as environment variables and a private method are Goose's. They are not a platform extension and are not documented for other agents; nothing outside the driver and this agent reads them. When the agent is extracted, its session options are designed there.
