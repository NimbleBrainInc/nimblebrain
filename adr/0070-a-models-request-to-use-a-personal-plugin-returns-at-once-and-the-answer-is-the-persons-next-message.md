# 0070. A model's request to use a personal plugin returns at once, and the answer is the person's next message

- Status: Accepted
- Date: 2026-11-19
- Serves: secure RBAC

## Context

ADR-0069 says a grant is written only from its owner's answer in a first-party
client, and that when a model calls for a grant "the runtime asks the person,
and the call returns what they answered". Read literally, the model's call
waits until the person answers.

A call that waits for a person holds its run open for as long as the person
takes, and needs somewhere to keep the pending question so the answer can find
the waiting call. The runtime keeps neither: the `beforeToolCall` approval gate
does not block on a person, a URL request (ADR-0050) reaches an outside MCP
client and not the runtime's own chat, and a run held in memory waiting for an
answer pins the conversation to one replica. Connector sign-in from chat
already reaches a person without waiting: the call returns, the client shows an
action, and the next turn sees the result.

## Decision

**A model's request to use one of the caller's personal plugins returns at
once and writes nothing. The client shows the person the question; their
answer, and any grant, come from the client; and the model learns the answer
as the person's next message.**

- The request is a model-visible action, `nb__manage_tools` with
  `request_plugin`, naming one of the caller's own personal plugins that is
  not granted in the conversation's workspace. It is refused in an unattended
  run and outside a conversation, where no person can answer.
- The client renders the question from the caller's own plugin listing, never
  from the call's arguments, so a request cannot make the client show a plugin
  that is not the caller's.
- **Use here** writes the grant through the first-party grant path (ADR-0038).
  The message the client then sends tells the model the answer and grants
  nothing.
- A run reads grants when it starts, so a plugin granted this way is reachable
  from the next turn.

This amends ADR-0069's "Only the owner grants": the rest of that section, and
of ADR-0069, stands.

## Consequences

- Nothing waits on a person, so no run is held open and no pending question is
  stored; the conversation is not pinned to a replica.
- The model ends its turn after asking. A conversation that needs the plugin
  continues when the person answers, which is the same rhythm as connector
  sign-in.
- A client that cannot render the question (a chat-channel bridge) shows the
  request's text, and the person grants from Plugins.

## Alternatives considered

- **The call waits for the answer.** Holds a run open for an unbounded time and
  needs a pending-answer store and replica affinity, for one question.
- **The model calls `grant_connector` and an approval gate asks first.** Makes
  the grant action model-visible, so its safety rests on the gate never being
  skipped; app-only visibility keeps the model off the grant entirely.
