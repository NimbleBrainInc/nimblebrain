# 0046. Task augmentation is the 2026-07-28 tasks extension, and nothing else

- Status: Accepted
- Date: 2026-10-03
- Serves: orchestrate remote MCP

## Context

This is about *task augmentation*, the protocol mechanism that carries a
long-running tool call, not the unattended job of ADR-0045.

MCP has defined task augmentation twice. The 2025-11-25 revision has a
tasks utility in core: the client attaches `params.task` to `tools/call`, the
server answers a `CreateTaskResult`, and the client polls `tasks/get` and reads
the payload with `tasks/result`. The 2026-07-28 revision moves tasks into an
extension (`io.modelcontextprotocol/tasks`, SEP-2663): the client names the
extension per request, the server alone decides whether to task a call and
answers either a complete result or a flat task (`resultType: "task"`), and
`tasks/get` carries the outcome.

The runtime uses task augmentation in three places. Inbound and outbound speak
both vocabularies; app to host speaks the 2025 utility under the extension's
name:

- **Inbound.** `/mcp` serves each era on its own leg (`src/api/AGENTS.md`). The
  2025 leg advertises `tasks` and answers task-augmented calls.
- **App to host.** A view starts a long call with Synapse's `callToolAsTask`,
  in the 2025 shape, and the iframe bridge forwards it to the 2025 leg. The
  bridge advertises this to the view under the extension's identifier
  (`web/src/bridge/host-capabilities.ts`) while serving the 2025 methods,
  `tasks/result` among them.
- **Outbound.** `mcp-task-client.ts` drives whichever vocabulary a connector
  negotiated.

Keeping the 2025 vocabulary has stopped being free:

- The MCP TypeScript SDK 2 deprecates it, and a v2 server cannot send a
  task-shaped `tools/call` result on a 2025 connection, explicit result schema
  or not. Serving it holds the 2025 leg on SDK v1, so the runtime carries two
  SDK major versions.
- The servers that run long calls have moved. FastMCP implements tasks only as
  the extension, negotiated on 2026-07-28 connections.
- Every place that uses task augmentation keeps two code paths for one
  capability.

## Decision

**Task augmentation is the 2026-07-28 tasks extension, in every place the
runtime uses it. The 2025-11-25 tasks utility is not served, not sent, and not
offered to apps.**

- **Inbound.** The 2025 leg of `/mcp` does not advertise `tasks` and holds no
  task store. A 2025 client's tool call runs to completion and answers a
  `CallToolResult`, whatever `params` it carries. A client that needs a
  long-running call speaks 2026-07-28.
- **App to host.** Synapse's task API speaks the extension's shape, and the
  bridge forwards it to the 2026 leg. The bridge serves no 2025 task method.
- **Outbound.** On a 2025 connection the runtime never attaches a task. A tool
  whose `execution.taskSupport` is `"optional"` is called inline. One whose
  `execution.taskSupport` is `"required"` is refused before dispatch, with an
  error that names the reason, rather than sent to fail at the server.

ADR-0029's policy is unchanged: a long-running call is a task, an inline call
retries once on transport failure, and a task call never retries. What changes is
which vocabulary carries it. ADR-0023's claim of `tasks` holds for the extension
only.

## Consequences

- One vocabulary to build, test and document, in each of the three places.
- The 2025 leg runs on SDK 2, and SDK v1 is out of the runtime: both legs of
  `/mcp`, the connector client and the bridge use the SDK 2 packages.
- SDK 2 changes two answers on the 2025 wire. A `resources/read` whose URI
  resolves nowhere answers `-32602`, not `-32002`. A tool whose `outputSchema`
  root is not an object is listed with that schema wrapped as the `result`
  property of an object schema, and its `structuredContent` is wrapped the same
  way.
- A 2025 client loses long-running calls on `/mcp`. Its calls still work, as
  ordinary blocking calls, and one that outlasts a timeout in the path fails the
  way any long blocking request does.
- A 2025-era server's tool that requires a task cannot be called. A tool that
  merely supports one is called inline, with the same timeout exposure.
- Synapse's task API changes shape, which is a breaking release for every app
  that starts a task.

## Alternatives considered

- **Keep both vocabularies** — rejected: it keeps SDK v1 in the runtime for a
  vocabulary the SDK and the servers that run long calls have left.
- **Translate 2025-shaped app calls to the extension in the bridge** — rejected:
  it keeps the 2025 vocabulary alive as an app-facing API the runtime has to
  maintain, which is the cost this decision removes.
- **Ask the SDK to serve 2025 task results again** — rejected: it fixes the
  inbound leg only, and asks upstream to extend a vocabulary it has deprecated.
