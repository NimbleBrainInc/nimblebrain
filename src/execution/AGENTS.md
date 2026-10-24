# Execution

Scope: `src/execution/`, the agent runtimes a run executes on. The door that decides a run is `Runtime.startRun` (`src/runtime/AGENTS.md`); why the two are split is ADR-0056.

## The seam

- **The door decides; a runtime executes.** `AgentRuntime.execute(run, io)` receives a `ResolvedRun` (prompt, history, tools, model, limits, signal) and a `RunIO` (the run's walled `ToolRouter` and its `EventSink`). A runtime never resolves tools, skills, models, identity or history itself, and may narrow what a run allows, never widen it.
- **The seam carries NimbleBrain types only.** No ACP, Goose or other vendor type appears in `types.ts`, `registry.ts` or anything `src/runtime/` imports. A protocol is translated at its runtime's own edge.
- **One event vocabulary.** Every runtime emits `EngineEventPayloads` events stamped with `ResolvedRun.runId`, and each run emits one `execution.bound` naming the runtime (and its own session id, when it has one). The conversation log and the browser stream read nothing else, which is why a conversation can move between runtimes.
- **Capabilities are declared, and the door refuses mismatches.** A runtime states what it holds (`RuntimeCapabilities`); `Runtime.agentRuntimeFor` refuses a run it cannot hold (spend accounts on a runtime with no spend gate). Never branch on a runtime's id anywhere outside `registry.ts`.
- **Layering:** `execution/` must not import `runtime/`, `tools/` or `platform/` (biome `noRestrictedImports`). It reaches the platform only through `RunIO`.

## ACP (`acp/`)

- **The generic runtime names no agent.** `acp-runtime.ts` knows ACP v1; everything one agent needs beyond it is an `AcpDriver` (`driver.ts`): how to open it, its working directory, its `session/new` `_meta`, its own session preparation, its prompt. A new ACP agent is a new driver plus a case in `registry.ts`. If a driver needs a hook the interface lacks, change the interface for every driver, not the runtime for one.
- **One run, one connection, one session.** The door owns the conversation, so every execution opens a fresh session from the history it is handed. No agent-side session is the record of anything.
- **Tools reach the agent through the tool projection only** (`tool-projection.ts`): a loopback MCP endpoint over the run's router, random port, path and bearer, closed with the run. It applies the engine's call checks and the run's `beforeToolCall` / `afterToolCall` hooks, and it emits `tool.start` / `tool.done`. The agent's own `tool_call` updates are logged, never recorded. Never point an agent at `/mcp/<wsId>`: that is a person's attended surface, not a run's bound.
- **The client advertises no `fs` and no `terminal`**, and grants a permission request only for a tool the projection serves.
- **Reasoning streams, it does not persist.** `agent_thought_chunk` becomes `reasoning.delta`, which the conversation store does not keep.
- **A child process gets only the environment its driver names** (`stdio-transport.ts`), and is killed when the run ends.

## The reference agent (`acp-agent/`)

NimbleBrain's own engine served as an ACP agent, driven by `acp/drivers/nimblebrain.ts`. It is how the ACP path is tested with no external dependency: `test/integration/execution/runtime-parity.test.ts` runs the same resolved run through the native runtime and through it, and requires the same record. A change to either runtime keeps that test passing; a new runtime joins it.
