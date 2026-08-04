# Changelog

## 0.6.0

### Changed

- **`list`, `search`, and `stats` are walled to one workspace, and it is not the
  caller's to name.** Each takes a `scope` argument alongside `input`, supplied
  by the platform source from the request's focused workspace. `list` no longer
  accepts `workspaceId` / `includeUnstamped` on its input — an omitted workspace
  used to mean "every workspace", and legacy records with no stamped workspace
  now fold into the owner's personal workspace by derivation instead of a client
  flag. `search` and `stats` were never scoped at all.
- `get`, `update`, `fork`, and `export` are unchanged: they address one
  conversation by id and stay owner-gated, so a direct link still resolves from
  whichever workspace the conversation lives in.

## 0.5.0

### Added

- `conversations__get` metadata now includes `workspaceId` — the workspace the
  conversation is sealed to. Additive and optional; absent on legacy records with
  no stamped workspace.

## 0.4.0

### Changed

- List no longer flickers on live updates. `data.changed` refreshes now run in
  the background (no skeleton swap) and only for conversation changes — other
  apps' `data.changed` are ignored. Initial load and view switches still show
  the skeleton.

## 0.3.0

### Added

- Live streaming indicator: a pulsing dot marks any conversation with an
  in-flight assistant turn. Driven by host-pushed `streamingConversationIds`
  (`useHostContext`), so it reflects real-time tab state without polling.

## 0.2.0

**Breaking — tool output shape.** The bundle now returns a display-oriented
message shape instead of the LLM-replay shape. Consumers that read
`conversations__get` or `conversations__stats` should update to match.

### `conversations__get`

Messages are now one-per-user-turn (previously one-per-LLM-iteration), with
top-level fields instead of nested `metadata`.

Before (per-iteration StoredMessage):

```json
{
  "role": "assistant",
  "content": "Edited the file.",
  "timestamp": "…",
  "metadata": {
    "toolCalls": [ { "id": "…", "name": "…", "output": "…", "ok": true, "ms": 12 } ],
    "inputTokens": 150,
    "outputTokens": 80,
    "model": "claude-sonnet-4-6",
    "llmMs": 1200,
    "iterations": 2,
    "skill": "code-review"
  }
}
```

After (per-turn DisplayMessage):

```json
{
  "role": "assistant",
  "content": "Edited the file.",
  "blocks": [
    { "type": "text", "text": "…" },
    { "type": "tool", "toolCalls": [ … ] }
  ],
  "toolCalls": [
    {
      "id": "…",
      "name": "collateral__patch_source",
      "appName": "collateral",
      "status": "done",
      "ok": true,
      "ms": 12,
      "input": { … },
      "result": { "content": [{ "type": "text", "text": "…" }], "isError": false }
    }
  ],
  "usage": { "inputTokens": 150, "outputTokens": 80, "model": "…", "llmMs": 1200 },
  "timestamp": "…"
}
```

Notable differences:
- Blocks interleave text and tool calls in timeline order — the old shape
  split a single LLM turn into multiple messages.
- `toolCalls[].output` (string) → `toolCalls[].result` (MCP envelope). Read
  `result.content[0].text` for the tool's text output.
- `status` and `appName` are derived and surfaced directly.
- `usage` (per-turn) replaces top-level `metadata.inputTokens` / etc.
- `skill` is not persisted and has been removed from output.

### `conversations__stats`

- `bySkill` removed. Skill was never persisted into the event log; the
  feature has been effectively dead.
- `byModel` and `topTools` are unchanged.

### `conversations__fork`

- Forked conversations now start with `totalCostUsd = 0`. Cost was
  previously summed from `metadata.costUsd` on each assistant message; the
  display shape no longer carries per-message cost (the bundle is decoupled
  from the runtime's price table). Cost can be recomputed live by any
  consumer that owns model pricing using the per-turn `usage` fields.

## 0.1.0

Initial release.
