# 0066. A tool is sent in full when turns use it, and a conversation keeps what it loaded

- Status: Proposed
- Date: 2026-11-18
- Serves: manage skills / orchestrate remote MCP

## Context

Every model call carries the full schema of each direct tool, ahead of the
system prompt and the messages. `surfaceTools` made a kernel tool direct when it
was an `nb__` tool or belonged to an identity source (`files`, `conversations`,
`tasks`). That test is about where a tool's data lives, not how often a turn
calls it. The task tools alone carry their whole definition (schedules, budgets,
judges, schemas) and make up more than half of the kernel tools' schema tokens,
while most turns never call one.

The cost lands twice. A hosted model pays to re-read those tokens on every call,
discounted where the prefix is cached. A small local model pays in context
window and prompt-processing time, and a prompt that size does not fit the
context some local servers allocate by default.

Moving tools out of the direct set has a cost of its own. Promoting a tool
changes the tools block, which precedes everything else, so the provider's
prompt cache misses on that call. Promotions last one run, so a conversation
that needed a tool on turn one has to find and promote it again on turn two, and
the block changes back and forth.

Small models also do not reliably find a proxied tool with `nb__search`,
promote it, and call it in a later message.

## Decision

**A kernel tool is direct because turns call it often.** The direct kernel set
is named (`DIRECT_KERNEL_TOOLS` in `src/tools/surfacing.ts`), chosen from
measured use: the discovery and skill tools and the basic file reads and
writes. Ownership no longer makes a tool direct. A new kernel tool starts
proxied and joins the set only when turns call it often.

**A job's tools arrive with its skill, not on every turn.** A skill whose
`triggers` match a message brings its `allowed-tools` into the direct set
(Tier 3, as before). The task-authoring skill declares triggers and the task
tools it covers, so a message about scheduling gets them and the guide together.

**What a conversation loads, it keeps.** The run door reads the conversation's
history once, before composition, and derives two things from it:

- The trigger match reads this turn's text, then the earlier user messages
  newest first. A matched skill stays composed until a newer message matches a
  different one.
- Every tool the conversation has called stays direct for the rest of it,
  appended after the turn's own set.

Both come from the recorded history, which only grows, so the tools block and
the composed skill change only when something is added: one cache miss per
addition, never one per turn. A history compaction drops what the folded
messages carried; it already rewrites the prefix.

## Consequences

- An ordinary turn sends a few thousand tokens of tool schemas instead of tens
  of thousands. A turn about tasks pays for the task tools while the
  conversation needs them.
- A turn that needs a cold tool for the first time spends one search and
  promote, and one cache miss. Hot-set membership has to be revisited as usage
  shifts; measuring it is the job of whoever changes the set.
- Trigger phrases are substrings, so a message that merely mentions a "task"
  loads the task tools. That costs tokens, never correctness.
- Unattended runs are unchanged in effect: they match no triggers and have no
  history to carry, and a task's `allowedTools` still bounds what it can reach.

## Alternatives considered

- Keep ownership as the test: pays for the task schemas on every call, and keeps
  small local models out.
- Derive the hot set from live metrics at runtime: adds machinery and makes the
  prompt vary between deployments; a named set reviewed by measurement is enough.
- Carry promotions in new conversation state: the history already records every
  call, and a second record could disagree with it.
- Join all user text and match once: an early message's skill would keep a later,
  lower-priority match from ever firing.
