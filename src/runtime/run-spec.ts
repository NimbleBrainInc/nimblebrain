/**
 * The shape of an agent run, as the run-start door reads it.
 *
 * A run is one pass of the agentic loop on behalf of one principal, walled to
 * one workspace. Every way of starting one — a person typing in chat, the
 * automations scheduler firing a cron tick, an operator pressing Run now —
 * describes itself as a {@link RunSpec} and hands it to `Runtime.startRun`,
 * which establishes the run and returns a {@link RunHandle}.
 *
 * The point of the type is that WHO asked is a parameter ({@link RunTrigger},
 * {@link RunPrincipal}) while HOW a run is established is not: the membership
 * gate, the tool set, the prompt, the budget, the sinks, and the engine are
 * resolved once, in one place, for every trigger. A new way to wake the agent
 * adds a `trigger` value and a caller that fills this in — not a second copy of
 * the establishment sequence.
 */

import type { EventSourcedConversationStore } from "../conversation/event-sourced-store.ts";
import type { Conversation } from "../conversation/types.ts";
import type { ConnectorSkillCandidate, EventSink, ToolSchema } from "../engine/types.ts";
import type { FileReference } from "../files/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import type { SkillMatch } from "../skills/matcher.ts";
import type { SelectedSkill } from "../skills/select.ts";
import type { Skill } from "../skills/types.ts";
import type { RequestContext } from "./request-context.ts";
import type { AppContext, ChatResult, TurnUsage } from "./types.ts";

/** A user-message text content block. */
export type UserTextPart = { type: "text"; text: string };

/** A user-message MCP `resource_link` attachment block. */
export type UserResourceLinkPart = {
  type: "resource_link";
  uri: string;
  mimeType: string;
  name: string;
};

/**
 * What woke the agent. Exactly today's callers, no more:
 *
 *  - `chat`     — a person in a conversation (`/v1/chat*`, `startTurn`).
 *  - `schedule` — an automations cron tick (`Scheduler.dispatchRun`).
 *  - `manual`   — an operator pressing Run now (`automations__run`).
 *  - `api`      — a caller driving the runtime directly (embedded, CLI, evals).
 *
 * The value is descriptive, not a policy switch: nothing branches on a
 * *specific* trigger, and `chat` is distinguished from the rest only where the
 * distinction is real — an attended run has a person in the loop, so it keeps
 * the authoring tools an unattended one must not reach.
 */
export type RunTrigger = "chat" | "schedule" | "manual" | "api";

/** Who a run acts as. */
export interface RunPrincipal {
  /**
   * The identity the run acts as — the caller's in production, `DEV_IDENTITY`
   * when no identity provider is configured. Drives prompt preferences and
   * role-based tool visibility.
   */
  identity: UserIdentity;
  /**
   * The resolved owner id (`resolveRequestOwnerId`): the privacy partition for
   * the conversation store, the file store, and the membership gate.
   */
  ownerId: string;
}

/** The conversation a run belongs to, for runs that have one. */
export interface RunConversationBinding {
  /** The conversation's own workspace event store. */
  store: EventSourcedConversationStore;
  /** The conversation record, already resolved (or created) by the door. */
  conversation: Conversation;
  /**
   * True when the run continues a conversation that already existed, false
   * when this run is the one that created it. It decides whether the workspace
   * membership behind the conversation is re-checked (see `Runtime.startRun`),
   * and whether the client is told a new conversation appeared.
   */
  resumed: boolean;
}

/** What the run is asked to do. */
export interface RunInput {
  /**
   * The user message that opens the run. For a run with a conversation it is
   * appended to the log and the engine reads the whole history back; for a run
   * without one it is the entire input.
   */
  content: Array<UserTextPart | UserResourceLinkPart>;
  /**
   * The author stamped on that message. Absent leaves the message unattributed,
   * which is what a dev-mode chat with no identity produces.
   */
  userId?: string;
  /** File references persisted alongside the message. */
  fileRefs?: FileReference[];
  /**
   * Text matched against skill triggers. Present for a chat (the user's raw
   * message); absent for an unattended run, which matches no trigger — its
   * prompt is a task description, not a phrase a skill should claim.
   */
  matchOn?: string;
  /** Glob patterns filtering which tools reach the model. */
  allowedTools?: string[];
  /** Scopes the run to one app's briefing and tool surface. Chat only. */
  appContext?: AppContext;
}

/** The ceilings a run may not exceed. */
export interface RunBudget {
  /** Per-request iteration cap; falls back to the configured default. */
  maxIterations?: number;
  /** Per-request input-token cap, treated as a CAP; falls back to config. */
  maxInputTokens?: number;
}

/**
 * How the door wants an aborted run reported.
 *
 *  - `throw`   — propagate the abort. The caller distinguishes cancel from
 *                error from the signal it owns, and the work done so far is
 *                already durable in the conversation log.
 *  - `partial` — return what the run accomplished, tagged
 *                `stopReason: "aborted"`. A run with nothing persisting its
 *                events has no other way to report the work it did, and silent
 *                abandonment is the worst failure mode.
 */
export type RunAbortDisposition = "throw" | "partial";

/** One agent run, fully described. */
export interface RunSpec {
  trigger: RunTrigger;
  principal: RunPrincipal;
  /**
   * The ONE workspace this run is walled to: its tools, its skills, its
   * connector overlays, its file partition, and its model slots. Membership of
   * it is re-checked at the door.
   */
  workspaceId: string;
  /**
   * The workspace the prompt NARRATES — installed apps, instruction overlays,
   * the "## Workspace" block, the workspace persona. Equal to `workspaceId` for
   * a run focused on its workspace; absent for a run merely *housed* in the
   * owner's personal workspace (an unfocused automation), which is walled to
   * that workspace without being about it.
   */
  briefingWorkspaceId?: string;
  /** Present when the run belongs to a persisted conversation. */
  conversation?: RunConversationBinding;
  input: RunInput;
  budget: RunBudget;
  /**
   * The run's model, already resolved and qualified. The door resolves it
   * because only the door knows whether a binding outranks the request — a
   * conversation runs on the model it was born with for its whole life.
   */
  model: string;
  /** Cancellation, threaded into the engine and down to every tool call. */
  signal?: AbortSignal;
  /** Per-request event sink (SSE stream, executor tap) joined to the defaults. */
  sink?: EventSink;
  onAbort: RunAbortDisposition;
}

/** A started (and completed) run. */
export interface RunHandle {
  /** The run's correlation id. */
  runId: string;
  /** The conversation the run belongs to, or `null` for a one-shot run. */
  conversationId: string | null;
  /**
   * The request context the run executed under. Exposed so a caller can spend
   * on the run's behalf after it returns — chat's auto-title does — and have
   * that spend attributed to the same conversation and workspace slots.
   */
  context: RequestContext;
  /** The agent's final assistant message. */
  output: string;
  /** The skill a trigger phrase matched, if any. */
  skillName: string | null;
  toolCalls: ChatResult["toolCalls"];
  stopReason: string;
  usage: TurnUsage;
}

/**
 * The prompt a run reasons with, and the tool surface it reasons over.
 *
 * One value because the two are resolved together and cannot be resolved apart:
 * the matched skill's `allowed-tools` decides the surfaced set, and the surfaced
 * set decides which bundle skills tool-affinity selection loads.
 */
export interface RunComposition {
  /** The ACTIVE tool set the model sees. */
  tools: ToolSchema[];
  /** Whether anything was pushed to the proxy tier (the prompt says so). */
  hasProxiedTools: boolean;
  /** The skill a trigger phrase matched, composed into the prompt. */
  skill: Skill | null;
  /** The match itself, which also carries the phrase, for load telemetry. */
  skillMatch: SkillMatch | null;
  /** Tool-affinity Layer 3 selections. */
  selectedLayer3: SelectedSkill[];
  /** The always-on context channel — every tier's `always` skills + persona. */
  alwaysOnSkills: Skill[];
  /** Overlays the engine may surface once into history mid-run. */
  connectorSkillCandidates: ConnectorSkillCandidate[];
  /** The cached system prefix. */
  stableSystem: string;
  /** The per-run head that rides the latest user message instead of the prefix. */
  volatileHead: string;
  /** Both segments folded, for budgeting and telemetry size counts. */
  systemPrompt: string;
}
