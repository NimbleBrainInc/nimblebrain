// ---------------------------------------------------------------------------
// SSE event schemas — declared payloads for events with stable shapes.
//
// Strategy: progressive enrichment, not a sweep. Events whose payloads have
// already been formalized as TypeScript interfaces (SkillsLoadedPayload,
// ContextAssembledPayload) are mirrored here as TypeBox schemas. Events
// with smaller, well-known shapes (`data.changed`, the `skill.*` and
// `file.*` events) get explicit schemas. Other events keep the loose
// `Record<string, unknown>` payload shape they had before; their schemas
// can be added when the payload stabilizes or when an emitter / consumer
// drift bug surfaces.
//
// Why TypeBox, not just TS interfaces: the same single-source-of-truth
// principle from skills + bridge + REST. The schemas here are declarative
// data, available to debug tools and SDK consumers; the TS types come from
// `Static<typeof X>` so emit sites are compile-checked. No runtime
// validation is wired in this phase — the engine emits events from code we
// own; the bug class is "we emit the wrong shape for the consumer," which
// the type system catches at compile time.
// ---------------------------------------------------------------------------

import { type Static, Type } from "@sinclair/typebox";

// Plain `Type.Union([Type.Literal(...)])` rather than the `StringEnum`
// helper used in platform tool schemas. The platform-tool schemas need
// the legacy `{type: "string", enum: [...]}` JSON Schema form (so AJV
// and external MCP clients see the expected shape); event schemas live
// inside the process and are walked by TypeBox's `Value.Check`, which
// requires the standard `Kind` discriminator that `Type.Unsafe` (used
// in `StringEnum`) omits.

const SkillScope = Type.Union([
  Type.Literal("org"),
  Type.Literal("workspace"),
  Type.Literal("user"),
  Type.Literal("bundle"),
]);
const WritableSkillScope = Type.Union([
  Type.Literal("org"),
  Type.Literal("workspace"),
  Type.Literal("user"),
]);

export const SkillsLoadedEntry = Type.Object({
  id: Type.String(),
  layer: Type.Literal(3),
  scope: SkillScope,
  version: Type.String(),
  tokens: Type.Number(),
  contentHash: Type.String({
    description: "SHA-256 hex of the skill body composed into the prompt.",
  }),
  loadedBy: Type.Union([Type.Literal("always"), Type.Literal("tool_affinity")]),
  reason: Type.String(),
});
export type SkillsLoadedEntry = Static<typeof SkillsLoadedEntry>;

export const SkillsLoadedPayload = Type.Object({
  skills: Type.Array(SkillsLoadedEntry),
  totalTokens: Type.Number(),
  /** Engine-attached run id for debug/correlation. Set by engine.run(). */
  runId: Type.Optional(Type.String()),
  /** Set by `delegate.ts` when forwarding a sub-run's skills.loaded out of
   *  the spawned engine into the caller's sink. */
  parentRunId: Type.Optional(Type.String()),
});
export type SkillsLoadedPayload = Static<typeof SkillsLoadedPayload>;

export const ContextAssembledSource = Type.Object({
  kind: Type.String(),
  count: Type.Optional(Type.Number()),
  tokens: Type.Number(),
  toolSetHash: Type.Optional(Type.String()),
  version: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  userId: Type.Optional(Type.String()),
  turns: Type.Optional(Type.Number()),
  compacted: Type.Optional(Type.Boolean()),
});
export type ContextAssembledSource = Static<typeof ContextAssembledSource>;

export const ContextAssembledPayload = Type.Object({
  sources: Type.Array(ContextAssembledSource),
  excluded: Type.Array(ContextAssembledSource),
  totalTokens: Type.Number(),
  modelMaxContext: Type.Optional(Type.Number()),
  headroomTokens: Type.Optional(Type.Number()),
  /** Engine-attached run id for debug/correlation. */
  runId: Type.Optional(Type.String()),
  /** Set by `delegate.ts` when forwarding a sub-run's event. */
  parentRunId: Type.Optional(Type.String()),
});
export type ContextAssembledPayload = Static<typeof ContextAssembledPayload>;

export const DataChangedPayload = Type.Object({
  /** When emitted by the agent's tool dispatch; absent when emitted by
   *  the runtime for cross-cutting changes. */
  source: Type.Optional(Type.Literal("agent")),
  server: Type.String(),
  tool: Type.String(),
});
export type DataChangedPayload = Static<typeof DataChangedPayload>;

const SkillEventCommonFields = {
  id: Type.String({ description: "Filesystem path of the skill." }),
  name: Type.String(),
  scope: WritableSkillScope,
};

export const SkillCreatedPayload = Type.Object({
  ...SkillEventCommonFields,
  type: Type.Union([Type.Literal("skill"), Type.Literal("context")]),
});
export type SkillCreatedPayload = Static<typeof SkillCreatedPayload>;

export const SkillUpdatedPayload = Type.Object({
  ...SkillEventCommonFields,
  /** Set by move_scope to indicate the source-of-update; absent on regular updates. */
  action: Type.Optional(Type.Literal("move_scope")),
  /** Original scope when action="move_scope". */
  from: Type.Optional(WritableSkillScope),
});
export type SkillUpdatedPayload = Static<typeof SkillUpdatedPayload>;

export const SkillDeletedPayload = Type.Object(SkillEventCommonFields);
export type SkillDeletedPayload = Static<typeof SkillDeletedPayload>;

export const FileCreatedPayload = Type.Object({
  id: Type.String(),
  filename: Type.String(),
  mimeType: Type.String(),
  size: Type.Number(),
});
export type FileCreatedPayload = Static<typeof FileCreatedPayload>;

export const FileDeletedPayload = Type.Object({ id: Type.String() });
export type FileDeletedPayload = Static<typeof FileDeletedPayload>;

// ── Discriminated event union ────────────────────────────────────────────
//
// Events with a typed payload are listed in the union below. Emitters
// invoking `eventSink.emit({ type, data })` against one of these names
// must pass a `data` shape matching the schema — TypeScript fails the
// build otherwise.
//
// Events not in the union still type-check as `{ type: EngineEventType,
// data: Record<string, unknown> }` per `src/engine/types.ts`. Add a new
// case here when an event's payload is stabilized; see the file header
// for the policy.

export const TypedEngineEvent = Type.Union([
  Type.Object({ type: Type.Literal("skills.loaded"), data: SkillsLoadedPayload }),
  Type.Object({ type: Type.Literal("context.assembled"), data: ContextAssembledPayload }),
  Type.Object({ type: Type.Literal("data.changed"), data: DataChangedPayload }),
  Type.Object({ type: Type.Literal("skill.created"), data: SkillCreatedPayload }),
  Type.Object({ type: Type.Literal("skill.updated"), data: SkillUpdatedPayload }),
  Type.Object({ type: Type.Literal("skill.deleted"), data: SkillDeletedPayload }),
  Type.Object({ type: Type.Literal("file.created"), data: FileCreatedPayload }),
  Type.Object({ type: Type.Literal("file.deleted"), data: FileDeletedPayload }),
]);
export type TypedEngineEvent = Static<typeof TypedEngineEvent>;
