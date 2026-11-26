# The tasks contract, `ai.nimblebrain.tasks` 1.0

An implementation of this contract holds a deployment's unattended work: task definitions,
their schedules, their runs and their batches. The **host** (the NimbleBrain runtime) owns the
clock, the work queue and the door every run goes through; it asks the implementation what is
due, what each run is, and records how each ended. People and agents use the implementation's
public tools and screen.

The contract is two things: this file, and one JSON document,
[`schemas/contracts/tasks/v1/contract.json`](../../schemas/contracts/tasks/v1/contract.json),
published at its `$id`. The document holds the identity, version, cardinality, whether the
contract needs run grants, every tool with its visibility, its unattended marking and its input
and output schema, and the closed list of errors. It is language-neutral. The TypeBox sources
it is emitted from (`source/`) are where it is authored, not part of it.

The key words MUST, MUST NOT, SHOULD and MAY are as in RFC 2119.

## 1. Identity, location, cardinality, tools

```json
{ "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.nimblebrain.ai/contracts/tasks/v1/contract.json",
  "contract": "ai.nimblebrain.tasks", "version": "1.0", "cardinality": "singleton",
  "grants": true,
  "tools": { "list": { "visibility": "public", "unattended": "allowed",
                       "input": { "$ref": "#/$defs/list_input" },
                       "output": { "$ref": "#/$defs/list_output" } }, "…": {} },
  "errors": { "public": ["…"], "private": ["…"] },
  "$defs": { "list_input": {}, "list_output": {}, "…": {} } }
```

- **`contract`** is the identity: a permanent reverse-DNS name, the name a plugin's
  `implements[].contract` uses. **`$id`** is where the document lives, stated in it and never
  derived from `contract`.
- **`version`** is `major.minor` (§14). **`cardinality`** is `singleton`: an instance has at
  most one enabled implementation, and a host that finds two refuses to start.
- **`grants: true`**: the host stamps a run grant on the implementation's `person` calls (§9).
- **An implementation is one MCP server.** It serves every tool the document names, each with
  the input and output schema its `$ref` names in `$defs`, listed as the tool's `inputSchema`
  and `outputSchema` itself, and the screen (§4). It MAY serve more; a client ignores what it
  does not know.
- **Each tool is `public` or `private`** (§3) **and `allowed` or `refused` unattended** (§10):

| Tool | Visibility | Unattended | Operation |
|---|---|---|---|
| `create` | public | refused | Save a task definition |
| `update` | public | refused | Patch a definition; `null` clears a field |
| `delete` | public | refused | Delete a definition; its run history stays |
| `list` | public | allowed | One page of the caller's tasks |
| `status` | public | allowed | One task's definition, state and recent runs |
| `run` | public | refused | Ask for a run of a task, or of an inline one-off; answers its `runId` |
| `run_result` | public | allowed | One run by id, in whatever state it is |
| `runs` | public | allowed | Ended runs, newest first, filtered |
| `cancel` | public | allowed | Cancel one run, queued or in flight |
| `upcoming` | public | allowed | Runs in flight and asked for, and the coming fires |
| `stats` | public | allowed | Per task, runs and verdicts since a time |
| `run_batch` | public | refused | Run one task over many inputs |
| `batch` | public | allowed | One batch and a page of its item results |
| `batches` | public | allowed | The caller's batches |
| `batch_control` | public | refused | Pause, resume, cancel, or re-run a batch's failures |
| `due` | private | refused | The occurrences due in a workspace, for the host to enqueue |
| `begin_run` | private | refused | A claimed occurrence: skip it, or the work spec to run |
| `end_run` | private | refused | Record how a run ended; answers the notices to deliver |
| `check_runs` | private | refused | Which of the host's in-flight runs to stop |
| `offer_event` | private | refused | Offer a routed notification to a task |
| `expire` | private | refused | Remove run data that ended before an instant |
| `delete_workspace` | private | refused | Purge every owner's tasks, runs and batches in a workspace |

## 2. Scope and principal

**Every call carries the host context** ([`contracts/host-context/CONTEXT.md`](../host-context/CONTEXT.md)).
No schema in this contract has a workspace, owner or principal input. This contract reads
`principal`, `workspaceId`, `ownerId`, `grant` and `unattended`.

**Scope** walls every call to one workspace and one owner. A task belongs to the owner and
workspace of the call that created it, and every run of it acts as that owner, in that
workspace.

1. **Out of scope is indistinguishable from absent.** Another owner's or another workspace's
   task, run or batch answers exactly as one that does not exist (`task_not_found`,
   `run_not_found`, `batch_not_found`; left out of lists).
2. **A call with no scope reads and writes nothing**: `scope_missing`. Public tools, and
   `begin_run`, `end_run`, `check_runs` and `offer_event`, need a workspace and an owner.
3. **`due`, `expire` and `delete_workspace` cross owners**: each reads or removes every
   owner's records in the scope's workspace and ignores the scope's owner.
4. **Workspaces are the host's.** The implementation never decides whether a workspace exists;
   every dimension of the host context is a fact the host verified, and the implementation
   creates whatever storage it needs on first use. A workspace it holds nothing for reads as
   one with no tasks. Keeping tasks out of a deleted workspace is the host's invariant.

**The principal** is `host` (the runtime) or `person` (a user, directly or through an agent).
A call that names no principal is not `host`.

## 3. Public and private tools

**Public tools accept either principal. Private tools accept only `host`. A private tool called
by any other principal fails `forbidden`, checked before the input and the scope, and nothing
is read or written.** A host never offers private tools to agents and never lists them where
agents or MCP clients connect; the server's refusal is what makes them unreachable.

A host MAY expose the public tools under its own names (`tasks__<tool>`); the tools, schemas
and behaviour are unchanged.

## 4. Definitions, runs, batches and the screen

These are the public tools' behaviour. The schemas are in the document; this section states
what a schema cannot.

- **A definition** is `{ manifest, body }`: `manifest` the settings, `body` the prompt. A
  task's id is derived from `manifest.name`; `create` refuses an id already stored
  (`task_exists`). `update` patches: an omitted field keeps its value, `null` clears it.
- **The schedule** is exactly one of `cron` (with `timezone`), `at` (fires once), `intervalMs`,
  or `match` (fires on routed notifications, §5.6), or absent (runs only when asked).
  `enabled` gates the schedule and events; `run` runs a disabled task.
- **A one-off** is a task with `kind: "oneoff"`, created by `run` or `run_batch` from an inline
  `definition`. With an `idempotencyKey`, its id is derived from the key.
- **`run`** asks for a run and answers at once with `{ status: "queued", runId }`; the run's
  state is read with `run_result`, and `cancel` stops it. A run that is refused when it is
  claimed (already running, a spent budget) is recorded `skipped` with its reason, and
  `run_result` shows it. Over MCP's task augmentation, `run` is a task whose id is the run id
  and whose result is `run_result`'s `ended` answer; the binding to MCP Tasks is the host's.
- **A run record** carries `execution` and `label`, derived from how it ended and its
  assessment, never stored. In 1.0 a run's assessment is the output schema's check alone:
  `pass` (the deliverable matched), `fail` (it did not), `not_assessed` (no schema). The
  verdict `uncertain` and the label `Needs review` from a verdict are reserved for judging
  (§14); `Needs review` also marks a run that completed around failed tool calls or was told
  to wrap up.
- **A run's result** (`run_result`) is its whole deliverable, its activity log (each tool
  call's name, whether it succeeded, why not, and how long it took; never its input or output),
  the files it wrote (as the host reported them), usage, and `structured` (the deliverable
  parsed against the output schema).
- **A batch** runs one task over many inputs, at most `concurrency` at once, under an optional
  `budgetUsd` and `stopWhen` rule. Validation is all or nothing.
- **Outputs are open**: a client ignores fields it does not know. Every instant in an output is
  an ISO-8601 date-time. A public tool carries its payload in `structuredContent` and a
  readable rendering in `content`. Every tool marked `unattended: "allowed"` except `cancel` is
  annotated `readOnlyHint: true`.
- **The screen** is two resources, MIME type `text/html;profile=mcp-app`: `ui://tasks/panel`
  (the scheduled-work page) and `ui://tasks/card` (the card shown under a `create` call). Its
  internals are the implementation's.

## 5. The run flow

The implementation decides **what** runs and **when it is due**; the host decides **when it
runs**, runs it, and enforces every limit. Nothing runs except through this flow.

### 5.1 Due

1. **The host calls `due({ until, cursor? })` once per workspace**, as `host`, with that
   workspace in scope and no owner. The implementation answers the occurrences in that
   workspace whose run it has decided is owed and not yet begun, due at or before `until`,
   paged by an opaque `nextCursor` (`null` on the last page).
2. **An occurrence is `{ ownerId, key, ref, notBefore? }`.** `key` names it within the
   workspace and stays the same for as long as it is listed; `ref` is what `begin_run` is
   called with; `notBefore` is when it is due, absent for at once (a requested run).
3. **The host enqueues each occurrence** on its work queue, scoped to the workspace, under
   `key`, not before `notBefore`. Enqueueing is idempotent per key, so the implementation lists
   an occurrence on every `due` until it is begun, and a repeat is one item.
4. **The change hint.** The host subscribes to the resource `tasks://due`. When a workspace's
   occurrences change (a definition saved, a run asked for, a run cancelled, a batch moved),
   the server SHOULD send `notifications/resources/updated` with `uri`
   `tasks://due/<workspaceId>`, and the host then calls `due` and `check_runs` for that
   workspace promptly. The hint carries nothing else and is never required: the host also
   polls every workspace on an interval, so a lost hint delays work and loses none.

### 5.2 Begin

5. **A worker claims an item** and calls `begin_run({ ref, attempt, token, now })` as `host`,
   with the workspace and the occurrence's owner in scope. `attempt` and `token` are the
   claim's; `now` is the host's clock (§6).
6. **The implementation answers `{ decision: "skip", reason }` or
   `{ decision: "run", work }`.** It skips an occurrence that is no longer owed (the
   definition changed, was disabled or deleted, the run was cancelled while queued, a once
   schedule is past its grace, a budget is spent) and records whatever its own records need.
   A skip settles the item.
7. **Fencing.** The implementation keeps the highest `token` it has seen for each run. A
   `begin_run` or `end_run` with a lower token fails `token_stale` and writes nothing.
8. **A run begins once.** When `attempt` is above 1 and an earlier claim already received a
   work spec for the run, the implementation MUST NOT answer that run again: it records the run
   as interrupted and answers `skip`. Running it again would repeat what it already sent or
   wrote.

### 5.3 Run

9. **The host checks the work spec, then runs it through its door** (§7): it verifies the
   grant (§9), refuses a run whose `exclusiveKey` is held, admits it under fair share, and
   executes it as the occurrence's owner, in the workspace, walled to that workspace's tools
   and the owner's own. A run refused here still ends: the host calls `end_run` with
   `stopReason: "not_started"` and the reason in `error`.
10. **Cancel.** The host calls `check_runs({ runIds })` for the runs of a workspace it has in
    flight, after a change hint and on its polling interval. It stops each id the answer
    lists, and that run ends with `stopReason: "cancelled"`. A run still queued is cancelled
    in the implementation's own records, and its claim is skipped (step 6).

### 5.4 End

11. **The host calls `end_run({ runId, token, outcome })`** once the run ends, however it ended
    (§8). The implementation records the run, derives its status, label, assessment and error
    streak, decides the next occurrence (a backoff, a retry, a batch's next item), and answers
    `{ notices }`.
12. **Notices** are what the host delivers to the run's owner: `{ id, title, body, level,
    link? }`. The implementation keeps no outbox. The host delivers each `id` at most once, so
    a repeated `end_run` answers the same notices and nothing is delivered twice. A notice
    carries nothing the owner could not read in the run itself.
13. **`end_run` is idempotent** for a run and token: a repeat records nothing new and answers
    the same notices. An `end_run` for a run `begin_run` never answered with a work spec fails
    `run_not_found`.

### 5.5 One run per task

The implementation names the key that excludes concurrent runs (`exclusiveKey`, opaque to the
host), typically one per task; a batch's runs name none or keys of their own. The host runs at
most one run per key per workspace at a time, across every process. Whether a refused run
waits or is skipped is the implementation's decision when the host reports it
(`not_started`, `exclusive_busy`).

### 5.6 Events

A workspace admin's route names a task; the host offers each notification that reaches the
route with `offer_event({ taskId, event, now })`, as `host`, with the route author (the task's
owner) in scope. The event carries its presentation only (`source`, `id`, `name`, `level`,
`title`, `subject`, `body`, `link`, `receivedAt`), never the connector's data.

- The implementation answers `{ accepted: true }` when the task takes it, or
  `{ accepted: false, outcome, classification, reason }`: `skipped` for a condition that clears
  on its own (the task is off, or its `match` does not want the event), `denied` for a
  configuration only a person changes.
- **A burst is one run.** An accepted event joins the task's pending event occurrence, whose
  `notBefore` is the first event's `now` plus the task's `debounceMs`; events are deduplicated
  by (`source`, `id`). The run carries them in its work spec's `notes`.
- **The fire ceiling ends a loop.** A task that would pass `maxFiresPerHour`, counted on the
  host's `now`, is disabled and the event is refused.

### 5.7 Retention and workspace deletion

- **`expire({ endedBefore })`**: the host calls it on a timer, with an instant it derives from
  the operator's retention policy. The implementation removes the data of runs that ended
  before it (records, results, the idempotency keys that name them), and one-offs whose
  definition and newest run are older. It never removes an open run, a run of a batch that is
  not settled, or a one-off a batch names. It answers what it removed.
- **`delete_workspace()`**: purges every owner's tasks, runs, batches and keys in the scope's
  workspace, and any storage held for it. Idempotent.

## 6. The clock rule

**Every instant the implementation decides on arrives as an argument from the host**: `until`
(what is due), `now` (lateness, budgets, backoff, debounce, the fire ceiling), the outcome's
`startedAt` and `endedAt` (what a run's record says), and `endedBefore` (retention). The
implementation MUST NOT read a wall clock to decide whether anything is due, late, spent,
expired, or allowed.

- It MAY read its own clock to stamp a record it writes (`createdAt`, `updatedAt`) and to
  render a public read (`upcoming`'s window, `stats`' default `since`). Neither decides
  anything.
- It MAY refuse an `at` it judges past when a definition is saved; whether the occurrence fires
  is decided only by the host's clock, where a past `notBefore` is due at once.
- The host's queue alone is the timer: `notBefore` is the only way the implementation delays
  work.

## 7. The work spec

`begin_run` answers work as a closed union on `kind`. **Version 1.0 has one kind, `agent`**:
an agent run through the host's door.

| Field | Required | Meaning |
|---|---|---|
| `kind` | yes | `"agent"` |
| `runId` | yes | The run's id, minted by the implementation; every record of the run uses it |
| `grant` | yes | The run grant stored with the definition, verbatim (§9) |
| `prompt` | yes | The instruction that opens the run; empty only with `skills` |
| `input` | no | JSON, at most 64 KiB serialized. The host wraps it in containment: data, never instructions |
| `notes` | no | Up to 8 strings of context for this run (an event's items, a retry's reason), contained like `input` |
| `outputSchema` | no | The JSON Schema the deliverable must match; the host renders the instruction |
| `allowedTools` | no | Globs the run's tools are narrowed to, enforced at the run's tool router |
| `skills` | no | Skills, by name, given in full before the first model call |
| `limits` | no | `{ maxIterations, maxInputTokens, maxRunDurationMs }`; the host lowers each to its ceiling |
| `model` | no | `provider:model-id` or a slot name |
| `thinkingEffort` | no | `low`, `medium`, `high`, `xhigh` or `max` |
| `spendAccounts` | no | `{ id, unit, remaining, sharedBy? }[]`, ids opaque to the host (below) |
| `exclusiveKey` | no | At most one run per key in flight in the workspace (§5.5) |
| `trigger` | no | `scheduled`, `manual` or `event`: telemetry only |

- **Containment and the output instruction are the host's.** The implementation passes data
  and a schema; it never writes prompt text that wraps them.
- **Spend accounts.** The implementation owns budgets (a task's token budget, a batch's
  `budgetUsd`); the host enforces them. Each account names its unit and what is left; runs in
  flight that name the same `id` share one live balance, and the host stops a run with
  `spend_limit` before a call the balance cannot pay for. `sharedBy` is the most runs that may
  draw on it at once. The host never interprets an id.
- **A host receiving a `kind` it does not know runs nothing** and calls `end_run` with
  `not_started` and `internal`.

## 8. The outcome

`end_run`'s `outcome` is the one schema every implementation receives, so it is closed and
small: what only the host observed. The implementation derives everything else.

| Field | Required | Meaning |
|---|---|---|
| `startedAt`, `endedAt` | yes | The host's instants (§6) |
| `output` | yes | The deliverable, the final answer's text; empty when none |
| `stopReason` | yes | Closed: `complete`, `max_iterations`, `max_input_tokens`, `spend_limit`, `length`, `content_filter`, `timeout`, `cancelled`, `error`, `other`, `not_started` |
| `wrapUpLimit` | no | With `complete`: `max_iterations` or `max_input_tokens`, the limit the host told the run to finish at |
| `error` | no | `{ code, transient, message? }`; present whenever `stopReason` is `error`, `other` or `not_started` |
| `usage` | yes | `{ inputTokens, outputTokens, iterations }` |
| `costUsd` | yes | What its model calls cost |
| `unpricedCalls` | no | Model calls with no known rates, not in `costUsd` |
| `spendAccountId` | no | With `spend_limit`: the account that stopped it (one the spec named, or one the host holds) |
| `limits` | yes | The caps it ran under, after the host's ceilings |
| `toolCalls` | yes | `{ name, ok, errorReason?, held?, ms }[]`, at most 1000 |
| `filesWritten` | yes | `{ uri, name? }[]`, opaque references the host recorded |
| `skillsDelivered` | yes | `{ name, loadedBy, status? }[]` |

- **`error.code`** is closed: `grant_invalid`, `membership_revoked`, `exclusive_busy`,
  `tools_unavailable`, `skills_unavailable`, `model_error`, `internal`. `transient` is the
  host's verdict on whether the same run may succeed later unchanged.
- **A `not_started` run made no model call.** `membership_revoked` and `exclusive_busy` are
  conditions that clear on their own; an implementation MUST NOT count them toward a failure
  streak.
- **Tool calls carry no input and no output.** What a tool was sent and what it answered belong
  to that tool's server; the activity log records that the call happened.
- **Files are what the host reports**, never parsed from another server's tool output.

## 9. Run grants

A run acts for its owner with no person present, so the host needs the owner's standing
authority, recorded when the owner set the work up. The mechanism is in the host-context spec
(§6 there); for this contract:

- **The document declares `grants: true`**, so the host stamps `grant` on every `person` call
  made outside an unattended run, in a workspace, by an owner.
- **The implementation stores the grant with the definition** whenever a call saves one:
  `create`, `update`, and `run` or `run_batch` with an inline `definition`, from chat, the
  screen or the host's door alike. A call that stores a new definition without a grant fails
  `grant_missing` and writes nothing; `update` without one keeps the stored grant.
- **It returns the grant verbatim in every work spec** for that definition, and nowhere else: no
  public tool's output, notice, log or error carries it.
- **The host verifies it before admitting a run**: its signature, that it names this contract,
  the workspace, and the occurrence's owner, and that the owner is a member of the workspace
  now. A run that fails ends `not_started` with `grant_invalid` or `membership_revoked`.

## 10. Unattended calls

- Every tool is marked `unattended: "allowed"` or `"refused"` in the document. The tools that
  author or start work (`create`, `update`, `delete`, `run`, `run_batch`, `batch_control`) are
  `refused`, so a run that reads untrusted content cannot rewrite or multiply the work that
  outlives it. The reads and `cancel` are `allowed`. Every private tool is `refused`.
- **The host never offers a `refused` tool to a run**, and stamps `unattended: true` on every
  call a run makes.
- **The server refuses a `refused` tool on a call with `unattended: true`** with
  `unattended_refused`, and changes nothing.

## 11. Errors

The document's `errors` is the closed list. A failed call writes nothing.

- **Public tools, and a tool name the server does not have**: `isError: true`, text JSON
  `{ code, error }`. `code` is one of `task_not_found`, `task_exists`, `run_not_found`,
  `batch_not_found`, `conflict`, `grant_missing`, `unattended_refused`, `scope_missing`,
  `invalid_input`, `unknown_tool`, and `error` begins with that code's prefix in
  `errors.public`. A caller decides on `code`, never on the text.
- **Private tools**: `isError: true`, text JSON `{ code, error }`. `code` is one of
  `forbidden`, `invalid_input`, `scope_missing`, `token_stale`, `run_not_found`,
  `task_not_found`, `internal_error`. `error` is diagnostic only.
- A refusal before any tool runs (a missing credential, `context_mismatch`) is the
  transport's.

## 12. Idempotency and fencing

- **`run` and `run_batch` take an `idempotencyKey`.** A repeat with the same key in scope
  answers what the first call asked for (`existing: true`) and asks for nothing; a repeat
  whose inline definition differs fails `conflict`. A key lasts as long as the run or batch it
  names.
- **Occurrence keys** make enqueueing idempotent (§5.1). **Tokens** fence `begin_run` and
  `end_run` (§5.2). **Notice ids** make delivery idempotent (§5.4).
- `create` refuses an id that exists. `delete`, `expire` and `delete_workspace` are idempotent
  by their answers.

## 13. Never in the contract

- **The medium.** No path, file handle, offset, query, table, or bucket or object key crosses
  the contract.
- **The host's machinery.** No queue position, admission key, lease, worker, slot or ceiling
  crosses it; `upcoming` lists what is queued and running without positions.
- **The grant's contents**, and the grant anywhere but a work spec.
- **Other servers' data.** A tool call's input and output, a connector's notification data,
  and another server's tool output never reach the implementation.
- **Prompt text the host wraps around data**: containment and the output-schema instruction.
- **Pricing and usage metering**, which stay the host's; the implementation records the
  `costUsd` the outcome reports.
- **Credentials and the carriage of the context**, which the host-context spec owns.

## 14. Versioning

- The version is `major.minor`. The document's URL names the major (`…/tasks/v1/…`).
- **The same major is compatible.** An implementation at `M.m` meets a need for `N.n` when
  `M = N` and `m >= n`. A host states the minor it needs and refuses an implementation below
  it.
- **A minor only adds**: an optional input field, an output field, a tool, an error code, a
  resource, a work `kind`, a `stopReason` or `error.code` value.
- **Closed values the host sends are bounded by the implementation's minor.** `stopReason` and
  `error.code` reach an implementation only with values its declared minor defines; the host
  maps a newer value to `other` or `internal` for an older implementation.
- **Anything else is a new major**, at its own URL beside this one.
- **Planned minor: judging.** Acceptance criteria and a judge on a definition, the `assess`
  and `judges` tools, a `call` work spec through which the host runs the judge's call, a
  person's verdict, and the verdict `uncertain` in use. None of it is in 1.0.

## 15. Conformance

A conformance runner that speaks only MCP to an implementation and reads only this document
is the next step, beside this file at `runner/`, as the conversations contract has. It will
check every tool's schemas, the walls, the principal rule (each private tool answers a
`person` with `forbidden`), the unattended rule, fencing and idempotency, and the run flow
driven with a stated clock.

Until then the document is held by unit tests: it compiles whole as JSON Schema 2020-12,
every `$ref` resolves, and every tool states its visibility and unattended marking.

Generate types for another language from the document's `$defs`; never write them by hand.
