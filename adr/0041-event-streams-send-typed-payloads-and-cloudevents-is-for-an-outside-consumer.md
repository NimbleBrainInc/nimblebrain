# 0041. Event streams send typed payloads, and CloudEvents is for an outside consumer

- Status: Accepted
- Date: 2026-09-30
- Serves: orchestrate remote MCP

## Context

The runtime emits engine events (`text.delta`, `tool.done`, `connector.installed`,
…) and sends some of them to clients over two SSE streams: `/v1/events` for a
user's workspaces, and `/v1/conversations/:id/events` for one conversation's
turns. Each frame is `event: <type>` and a JSON payload, with an `id:` line
where a client resumes from a sequence number.

Every engine event type has one named payload schema in `EngineEventPayloads`
(`src/engine/schemas/events.ts`): one type, one shape. What each stream sends is
declared in `src/api/schemas/events.ts` (`WorkspaceStreamEvents`,
`ConversationStreamEvents`), generated into the web package, and pinned to the
engine payloads by `events-drift-guard.ts`. Both consumers of the streams, the
web shell and the channels service, are our own code and read these types.

CloudEvents is a standard event envelope: required attributes (`specversion`,
`id`, `source`, `type`) and optional ones (`time`, `subject`, `dataschema`,
`datacontenttype`) around the payload, with protocol bindings that say how an
event travels over HTTP, Kafka, NATS, MQTT, AMQP or WebSockets. It defines no
binding for SSE. Its closest analog, the WebSockets binding (a working draft),
allows only structured mode, the whole event serialized as one JSON object,
because a WebSocket message has no per-message metadata to carry attributes in
binary mode. SSE gives a message only `event`, `id` and `retry`.

MCP clients never see these streams: `/mcp` speaks JSON-RPC, and an MCP App
iframe receives server notifications as JSON-RPC messages the shell rebuilds
from the event (`web/src/hooks/useServerNotificationRelay.ts`).

## Decision

- **The SSE streams send `event: <type>` and the bare payload.** The type is the
  engine's short name; the payload is its `EngineEventPayloads` entry as JSON;
  `id:` carries a resume point where one exists. The contract is
  `src/api/schemas/events.ts`, held to the engine catalog by the drift guard.
- **The streams do not wrap events in a CloudEvents envelope.** Structured mode
  would repeat roughly 120–150 bytes of attributes on every frame, and the
  stream's most frequent frame, `text.delta`, carries a payload of about 50.
  Sending stream-level attributes once and per-event ones in the SSE fields
  would be a mapping of our own that no CloudEvents SDK reads, so it would cost
  the change without giving interoperability. Every consumer already has a
  compile-time contract for each event.
- **An event delivered to a consumer outside our code is a structured-mode
  CloudEvent.** A tenant webhook, a bus whose subscribers are deployed
  independently of the runtime, or an audit export gets:
  - `type`: `ai.nimblebrain.` and the engine type (`ai.nimblebrain.tool.done`);
  - `source`: the path of what emitted it (`/v1/conversations/<id>`,
    `/v1/workspaces/<id>`);
  - `id`: unique within that source;
  - `dataschema`: the published JSON Schema of the event's TypeBox payload.

  The envelope is built at that edge from `EngineEventPayloads`.
- **Internal names stay short.** Persisted conversation files, the event sinks
  and the stream catalogs key on the engine's names; the `ai.nimblebrain.`
  prefix exists only in an envelope.

## Consequences

- Adding an event to a stream is an entry in its catalog and a line in the
  drift guard; no envelope code changes.
- The web shell and channels parse frames as they do today. A consumer that
  wants a CloudEvent from a stream frame has no standard way to get one.
- The first outside delivery carries the envelope work: the attribute rules
  above, publishing each payload's JSON Schema, and a builder from an engine
  event to a CloudEvent.
- An internal bus that carries cache invalidation or fan-out between replicas of
  the runtime sends what the runtime defines. Both ends are the same code, so an
  envelope adds nothing there.
- ADR-0008 stands: notifications are pulled into a workspace inbox, and no
  cluster bus triggers tenant actions. A bus between services is a different
  thing from a bus that acts for a tenant, and a proposal for either answers
  0008's argument about whose credentials a trigger uses.
- Revisit this when an event consumer that is not first-party appears, or events
  travel between independently deployed services over a bus. Either makes the
  envelope the contract a third party reads, which is what it is for.

## Alternatives considered

- **Structured CloudEvents on the streams** — rejected while every consumer is
  first-party: the per-frame cost is real on token streaming and buys a format
  neither consumer needs.
- **Binary-style mapping: stream attributes once, `type` and `id` in the SSE
  fields** — rejected: CloudEvents defines no such mode for SSE, so the stream
  would be CloudEvents in name while every consumer reassembled events by our
  rules.
- **Rename the engine types to reverse-DNS everywhere** — rejected: the short
  names are stored in every conversation file and read by every sink, so a
  rename is a data migration that buys nothing the envelope's `type` does not.

Sources: [CloudEvents protocol bindings](https://github.com/cloudevents/spec/tree/main/cloudevents/bindings),
[CloudEvents WebSockets binding](https://github.com/cloudevents/spec/blob/main/cloudevents/bindings/websockets-protocol-binding.md).
