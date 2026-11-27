# Tasks plugin

Scope: `packages/tasks/`. An implementation of the tasks contract
(`contracts/tasks/CONTRACT.md`, `ai.nimblebrain.tasks` 1.0): an Agent Plugin with one MCP
server, on the local filesystem, its screen and its skill. The runtime binds it by default as
a system plugin (`src/config/plugins.ts`), starts its server over stdio, and runs its due work
through its run worker (`src/runtime/AGENTS.md`, "The run worker"). How to run it standalone is
in `README.md`.

## Boundaries

- **Never import the kernel.** This package imports only `packages/server-sdk` and reads the
  contract document (`schemas/contracts/tasks/v1/contract.json`). The screen (`ui/`) is its own
  package. Biome refuses any other import that leaves the package.
- **The contract document is the interface.** `tools/list` serves each tool's schemas from the
  document unchanged, inputs are validated against them (formats asserted), and visibility,
  unattended and grant marking come from it. Private answers are checked against their closed
  schemas before they leave (`server.ts`). Changing a tool's shape is a contract change.
- **`plugin.json` and `mcp.json` follow Agent Plugins 1.0.0**; NimbleBrain's declaration is only
  `extensions["ai.nimblebrain"].implements`. Trust, presence and location are the operator's.
- **The authoring guide is `skills/task-authoring/SKILL.md`**, in the format's skills layout. A
  host that loads a plugin's skills reads it (NimbleBrain binds it to `tasks__*`), and the server
  serves its body, without the frontmatter, as its `instructions`, so an MCP client that loads
  no skills learns the same order of calls. A change to how the tools are used is a change to
  that file. Every JSON example in it is a call the contract accepts (each cron with its
  `timezone`), which `test/unit/plugins/tasks-skill-examples.test.ts` checks against the
  contract's `create` input.

## Calls

- **The context is the host context**, read by `packages/server-sdk`, believed only from an
  authenticated host transport (`src/main.ts`): stdio by construction; HTTP by
  `Authorization: Bearer $NB_TASKS_TOKEN` (at least 32 characters, `host` on every tool, so
  HTTP listens on loopback and warns otherwise).
- **Every `tools/call` is decided in one order** (`src/server.ts`): `unknown_tool`, `forbidden`
  (private tool, principal not `host`), `unattended_refused` (public tool marked refused, call
  with `unattended: true`), `invalid_input`, `scope_missing` (public tools and `offer_event`
  need a workspace and an owner; the other private tools a workspace), `grant_missing` (any
  tool marked `grant: true` called with no grant), then the tool. A private tool called by the
  host with `unattended: true` runs: the contract has no private code for it.
- **Errors are `{ code, error }`**; a public error's text is its prefix then the id or detail.
  An unexpected failure answers `internal_error` (private) or a JSON-RPC internal error
  (public) with a fixed message; its detail goes only to stderr.

## The clock rule

Every decision is taken on a host instant: `due`'s `now` and `until`, `begin_run`'s and
`offer_event`'s `now`, an outcome's `startedAt`/`endedAt`. The plugin's own clock only stamps
`createdAt`/`updatedAt`/`requestedAt` and renders `upcoming`'s window and `stats`' default
`since`. A schedule check that needs no clock (an unknown timezone, a cron that matches no
date) is decided at write time. A once's lateness is decided only on the `due` that would
produce it: whether the host was down at its time is knowable only there.

## How the run flow is kept (`src/flow.ts`)

- **Occurrences.** A timed schedule's next occurrence is the definition's `nextRunAt`. Saving or
  changing a schedule clears it, and the next `due` anchors it on its `now` (a cron's next fire
  after `now`, an interval at `now`, a once at its `at`). Its ref and key are
  `s:<definition uid>:<epoch ms>`: a moved time is a new key, and a claim of the old one
  answers skip. Every other run (`run`, a batch item, a pending event occurrence) is a queued
  run record; its ref is `r:<run id>`, its key that plus `@<notBefore ms>`.
- **`due`** anchors, retires a once not yet listed whose `notBefore` is more than
  `ONCE_GRACE_MS` (1 h) before its `now` (recorded skipped: missed; never listed), and lists
  occurrences at or before `until`, ordered by (`notBefore`, key),
  paged by a cursor that encodes that position. `cancel` is every begun run asked to stop whose
  `end_run` has not landed, whole on every page. Retention runs on the first page only.
- **Fencing** (`state.fences`, per ref): the highest token and what it was answered. The same
  token repeats the answer (a run's grant and work spec are read back from the answer blob); a
  lower one is `token_stale`; a higher one after a run was answered marks that run
  interrupted, provisionally, and answers skip with `interrupted: { runId, token }`, the token
  that received its work. Every later claim answers the same `interrupted` until that run's
  `end_run` lands, so a second takeover never strands it. `end_run` is accepted from
  the run's token only, first-wins: an ended run answers its stored notices.
- **What a claim checks**: scheduled: the occurrence is still `nextRunAt`, the task enabled,
  not already running, its budget not spent. A once listed by a `due` (`onceListed`) is never
  judged late again: it runs however long the host's queue held it; requested: the run still
  queued, the task still there, an event run's task still enabled with an event schedule, no
  other non-batch run of the task running, the budget not spent. A refusal is recorded skipped
  (a scheduled one moves `nextRunAt` on); a batch run refused for its budget or a deleted task
  pauses its batch.
- **The work spec** carries the prompt, input, events as `notes` (JSON arrays of their
  presentation, packed into at most 8 notes), the output schema, `allowedTools`, `skills`, the
  definition's limits, model, thinking effort, spend accounts (`task-budget:<uid>@<window>:<unit>`
  per token cap, `task-batch:<batch id>` in USD), `exclusiveKey: task:<uid>` (none for a batch
  run) and the trigger. No prompt text wraps any of it.
- **`end_run`** derives the record from the outcome (`src/runs.ts`): status, execution and
  label, unrecovered tool failures, the output-schema verdict; then the task's state: run count,
  budget window usage, last run, the failure streak (backoff, auto-disable, the one run-failed
  notice per stretch), a once retired, the next occurrence; then the batch's item.
- **Grants**: stored with the definition on `create`; `update`, `run`, `run_batch` and
  `batch_control` replace it with the call's; `delete` drops it with the definition. It
  leaves the plugin only in `begin_run`'s run answer; views are built field by field
  (`src/views.ts`) and notices carry ids only.
- **The change hint** `tasks://due/<workspaceId>`: the store raises a change after any
  committed call that alters what `due` answers (a definition saved or deleted, a run asked
  for or cancelled, a batch moved, an event accepted, a run ended), and the transport sends
  `notifications/resources/updated` for that URI: HTTP through the handler's listen bus,
  stdio through the connection's server (only to a subscribed URI on a 2025-era connection).
  Reading or subscribing is the host's alone, for its own workspace (`hintRefusal`); a
  `subscriptions/listen` is checked at the entry (`src/main.ts`), before the SDK's listen
  router, which has no hook. A stateless 2025-era HTTP connection cannot receive the hint.

## Storage (`src/store.ts`)

- **Layout:** `<data>/workspaces/<workspaceId>/state.json` (definitions with their grants,
  open runs, fences, batches and their items, idempotency keys, and the ended-runs log's file
  and committed length), `runs-<n>.jsonl` (ended runs, one record per line),
  `blobs/<name>.json` (write-once: a run's input, the answer `begin_run` gave, a run's result,
  a batch's inputs).
- **`state.json` is the only commit point.** A call changes the workspace in memory; then its
  blobs are written, its ended runs appended to the log, and `state.json` replaced atomically
  (fsynced, renamed) with the log's new length. An append is committed by that replace and by
  nothing else, so the log never holds more or less than the state says. A call that throws
  evicts the workspace from memory.
- **Loading cuts the log to its committed length** before anything reads or appends: an
  append whose commit never landed, or a torn tail, is gone, and the host's retry records the
  call once. Compaction (retention) writes the log whole to the next generation's file, which
  the replace naming it commits; log files the state does not name, and blobs no record names,
  are removed on load.
- **One process owns a data directory.** All I/O is synchronous, so one process's calls never
  interleave; two processes on one directory are not serialized. The workspace id is the only
  path segment taken from a call.
- **Retention** (`--retention-days`, default 180) is judged on `due`'s `now`: ended runs and
  their blobs, fences and keys; skip fences and event dedup entries as old; one-offs with no
  runs left whose first `due` (`seenAt`) is older. Never an open run, a run of a running or
  paused batch, or a one-off a batch names. Batches are kept.

## The screen

`ui://tasks/panel` and `ui://tasks/card` (`text/html;profile=mcp-app`) serve the built
`ui/dist/index.html` (`--screen` names another), the card marked with
`<meta name="nb-tasks-view" content="card">`; a placeholder page when it is not built. `ui/`
is its own package, installed, built, tested and typechecked with the platform app UIs, and
built in the image (the Dockerfile). The handshake carries `_meta["ai.nimblebrain/host"]` with
the sidebar placement (`HOST_META`), through the server SDK's `declareHostMeta`.

## Behaviour worth knowing

- **Judging is not here** (CONTRACT.md §15): no criteria, judge, `assess`, `judges`, person's
  verdict or `onPoorResult`. A deliverable that fails its output schema reads `Poor result` and
  raises a notice.
- **`run` answers at once** with `{ runId, taskId }`; the run is queued and followed with
  `run_result`. No queue position, no synchronous wait, no MCP Tasks handle.
- **`run` refuses a task that already has a run** (`activeRunOf`, `src/records.ts`): one
  outside a batch running, or a `run` still queued, is `conflict` naming it, so the caller
  learns at once. The claim's `Already running` skip stays as the backstop for what the
  call cannot see (a scheduled or event run that begins first).
- **Instants are the host's.** A schedule is placed on the next `due`, not at write time; a
  past `at` is accepted at write and judged on the `due` that would produce it: within its
  grace it is listed and runs, past it it is missed. A once produced in time runs however long
  the queue holds it; only one first seen past its grace (the host was down) is missed.
- **Budget windows are UTC calendar days and months.** A spent window refuses every claim
  (recorded skipped), whatever triggered it.
- **`grant_invalid` and `membership_revoked` disable the definition at once** with a notice; a
  grant-marked call re-stamps it and `enabled: true` turns it back on.
- **Every auto-disable raises a notice** (failure streak, budget, grant, fire ceiling).
- **The fire ceiling is judged when an event arrives**, on its `now`, and refuses that event
  (`denied`, `event_fire_ceiling`).
- **Event runs carry their events as `notes`** (data); the host frames them.
- **Writes do not validate what only the host knows**: a model reference, `allowedTools` globs,
  and skill names. The host's unattended rule keeps a run from the tools that author or start
  work. The one check on `allowedTools` reads this contract's own tools (`unrunnableTools`,
  `src/public.ts`): `create`, `update` (only the list it is given, so a task saved earlier can
  still be paused) and an inline definition refuse an entry that names only `tasks__<tool>`
  tools marked refused unattended, since a run could never call one and the host drops it.
- **A run's failures keep their reasons**: `toolFailures` (on the run view and `stats`'
  `recent`) is each tool in `unrecoveredToolFailures` with its last failed call's
  `errorReason`, so the screen can say why a run needs the person without reading its result.
- **Unrecovered tool failures are judged per tool name**, since the outcome carries no call
  input: a failed call is recovered by any later success of the same tool (a `bad_input` call
  by the next call that is not itself `bad_input`).
- **Batch runs leave the task's schedule alone**: they count toward its runs and token budget,
  never its last run, next occurrence or failure streak. A batch's default concurrency is 2.
- **`delete` of an absent task answers `deleted: false`**; `cancel` of an unknown run is
  `run_not_found`, of an ended one `cancelled: false`.
- **Retention is the server's flag** (`--retention-days`, default 180); the built-in binding
  runs the default.

## Tests

- `test/integration/tasks-plugin-default.test.ts` boots the runtime with its defaults and
  drives the plugin through the kernel: grants, run now, schedules, cancel, events, batches,
  notices, forged authority, unattended refusal, the public-only runner at `/mcp/<wsId>`, and
  workspace delete; `test/integration/tasks-off.test.ts` covers tasks off and chat off.
- `test/integration/tasks-plugin-conformance.test.ts` runs the contract's runner
  (`contracts/tasks/runner/conformance.ts`) against `bin/nb-tasks --http` in full mode (every
  case passes) and public-only mode (only `no private tool is listed` fails, which holds a
  host's door, not an implementation), and checks the credential, the address, stdio and the
  handshake placement.
- `test/unit/plugins/tasks-plugin.test.ts`: the store's commit point and recovery, the
  failure policy, once schedules, budget windows, a batch's budget stops, retention's guards,
  internal failures.
- `test/unit/plugins/server-sdk-handshake.test.ts` guards `declareHostMeta` against an MCP SDK
  that renames the members it wraps.
