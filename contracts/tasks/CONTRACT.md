# The tasks contract, `ai.nimblebrain.tasks` 1.0

An implementation of this contract holds a deployment's unattended work: task definitions,
their schedules, their runs and their batches. The **host** (the NimbleBrain runtime) owns the
clock, the work queue and the door every run goes through; it asks the implementation what is
due and what each run is, and reports how each ended. People and agents use the
implementation's public tools and screen.

The contract is two things: this file, and one JSON document,
[`schemas/contracts/tasks/v1/contract.json`](../../schemas/contracts/tasks/v1/contract.json),
published at its `$id`. The document holds the identity, version, cardinality, every tool with
its visibility, unattended and grant marking and its input and output schema, the schemas tools
share, and the closed list of errors. It is language-neutral. The TypeBox sources it is emitted
from (`source/`) are where it is authored, not part of it.

The key words MUST, MUST NOT, SHOULD and MAY are as in RFC 2119.

## 1. Identity, location, cardinality, tools

```json
{ "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.nimblebrain.ai/contracts/tasks/v1/contract.json",
  "contract": "ai.nimblebrain.tasks", "version": "1.0", "cardinality": "singleton",
  "tools": { "create": { "visibility": "public", "unattended": "refused", "grant": true,
                         "input": { "$ref": "#/$defs/create_input" },
                         "output": { "$ref": "#/$defs/create_output" } }, "…": {} },
  "errors": { "public": ["…"], "private": ["…"] },
  "$defs": { "create_input": {}, "…": {}, "work_spec": {}, "run_outcome": {},
             "occurrence": {}, "notice": {} } }
```

- **`contract`** is the identity: a permanent reverse-DNS name, the name a plugin's
  `implements[].contract` uses. **`$id`** is where the document lives, stated in it and never
  derived from `contract`.
- **`version`** is `major.minor` (§15). **`cardinality`** is `singleton`: an instance has at
  most one enabled implementation, and a host that finds two refuses to start.
- **An implementation is one MCP server.** It serves every tool the document names, each with
  the input and output schema its `$ref` names in `$defs`. It MAY serve more; a client ignores
  what it does not know.
- **Shared schemas** are `$defs` entries under their own names: `occurrence`, `work_spec`,
  `run_outcome`, `notice`. Only private tools refer to them, as `#/$defs/<name>`, and a server
  lists such a schema with the shared `$defs` it names bundled beside it. A public tool's
  schema is whole, with no `$ref`, so any MCP client reads it.
- **Each tool is `public` or `private`** (§3), **`allowed` or `refused` unattended** (§10), and
  **the public tools that save or start work carry `grant: true`** (§9):

| Tool | Visibility | Unattended | Grant | Operation |
|---|---|---|---|---|
| `create` | public | refused | yes | Save a task definition |
| `update` | public | refused | yes | Patch a definition; `null` clears a field |
| `delete` | public | refused | | Delete a definition and its grant; its run history stays |
| `list` | public | allowed | | One page of the caller's tasks |
| `status` | public | allowed | | One task's definition, state and recent runs |
| `run` | public | refused | yes | Ask for a run of a task, or of an inline one-off; answers its `runId` |
| `run_result` | public | allowed | | One run by id, in whatever state it is |
| `runs` | public | allowed | | Ended runs, newest first, filtered |
| `cancel` | public | refused | | Cancel one run, queued or in flight |
| `upcoming` | public | allowed | | Runs in flight and asked for, and the coming fires |
| `stats` | public | allowed | | Per task, runs and verdicts since an instant |
| `run_batch` | public | refused | yes | Run one task over many inputs |
| `batch` | public | allowed | | One batch and a page of its item results |
| `batches` | public | allowed | | The caller's batches |
| `batch_control` | public | refused | yes | Pause, resume, cancel, or re-run a batch's failures |
| `due` | private | refused | | The occurrences due in a workspace, for the host to enqueue, and the runs to stop |
| `begin_run` | private | refused | | A claimed occurrence: skip it, or the run to execute |
| `end_run` | private | refused | | Record how a run ended; answers the notices to deliver |
| `offer_event` | private | refused | | Offer a routed notification to a task |
| `delete_workspace` | private | refused | | Purge every owner's tasks, runs and batches in a workspace |

## 2. Scope and principal

**Every call carries the host context** ([`contracts/host-context/CONTEXT.md`](../host-context/CONTEXT.md)).
No schema in this contract has a workspace, owner, principal or clock input. This contract
reads `principal`, `workspaceId`, `ownerId`, `now`, `grant` and `unattended`.

- **Public tools and `offer_event` are walled to one workspace and one owner.** A task belongs
  to the owner and workspace of the call that created it.
- **`due`, `begin_run`, `end_run` and `delete_workspace` are walled to one
  workspace** and carry no owner: they read or write every owner's records there. The host
  learns a run's owner from the grant it verifies (§9), never from the implementation.
- **Out of scope is indistinguishable from absent.** Another owner's or another workspace's
  task, run or batch answers exactly as one that does not exist (`task_not_found`,
  `run_not_found`, `batch_not_found`; left out of lists).
- **Every call is judged at its context's `now`** (§6), so every tool needs one.
- **A call missing what its tool is walled to, or missing `now`, reads and writes nothing**:
  `scope_missing`.
- **Workspaces are the host's.** The implementation never decides whether a workspace exists;
  it creates whatever storage it needs on first use, and a workspace it holds nothing for reads
  as one with no tasks. Keeping tasks out of a deleted workspace is the host's invariant.
- **The principal** is `host` (the runtime) or `person` (a user, directly or through an agent).
  A call that names no principal is not `host`.

## 3. Public and private tools

**Public tools accept either principal. Private tools accept only `host`. A private tool called
by any other principal fails `forbidden`, checked before the input and the scope, and nothing
is read or written.** A host never offers private tools to agents and never lists them where
agents or MCP clients connect; the server's refusal is what makes them unreachable. A host MAY
expose the public tools under its own names (`tasks__<tool>`); the tools, schemas and behaviour
are unchanged.

## 4. Definitions, runs, batches, outputs and the screen

The public tools' behaviour, where a schema cannot state it.

- **A definition** is `{ manifest, body }`: `manifest` the settings, `body` the prompt. A
  task's id is derived from `manifest.name`; `create` refuses an id already stored
  (`task_exists`). `update` patches: an omitted field keeps its value, `null` clears it.
- **The schedule** is written as exactly one of `{ cron, timezone }`, `{ at }`,
  `{ intervalMs }`, or `{ match, debounceMs?, maxFiresPerHour? }` (fires on routed
  notifications, §5.6), or left out (runs only when asked). A cron always names its IANA
  timezone. A read returns the schedule as one object holding the keys of the form it was
  written in. `enabled` gates the schedule and events; `run` runs a disabled task.
- **A token budget** (`tokenBudget`) caps the tokens a task's runs spend per UTC calendar day,
  per UTC calendar month, or in total. The implementation enforces it through the run's spend
  accounts (§7), and disables the task when it is spent.
- **`allowedTools` and `skills` are opaque to the implementation.** It stores them and puts them
  in the work spec; only the host matches a glob or resolves a skill. One rule reads this
  contract's own tools: `create`, `update` (the list it is given) and an inline `definition`
  refuse with `invalid_input`, naming them, the `allowedTools` entries that begin `tasks__` and,
  with `*` matching any characters, match at least one `tasks__<tool>` (§3) and only tools marked
  `refused` (§10). No run can call such a tool, so the entry only hides that from the author. An
  entry that also matches a tool runs may call (`tasks__*`), or names another server's tool, is
  kept as given.
- **A one-off** is a task with `kind: "oneoff"`, created by `run` or `run_batch` from an inline
  `definition`. With an `idempotencyKey`, its id is derived from the key.
- **`run`** asks for a run and answers at once with `{ runId, taskId }`; `run_result` reads its
  state and `cancel` stops it. **One run per task at a time**: `run` of a task that has a run
  running, or one a `run` asked for still queued, fails `conflict` naming that run, and asks
  for nothing (a batch's runs and an event run not yet due do not count). A run refused when
  it is claimed (one began first, a spent budget) is recorded `skipped` with its reason. Over MCP's task augmentation, `run` is a task
  whose id is the run id and whose result is `run_result`'s answer once the run has ended; that
  binding is the host's.
- **One status vocabulary.** A run's `execution` (`queued`, `running`, `skipped`, `completed`,
  `incomplete`, `failed`, `cancelled`) says how it ended, or that it has not; its `label`
  (`Succeeded`, `Poor result`, `Needs review`, `Failed`, `Skipped`, `Cancelled`, `Queued`,
  `Running`) is what a person reads. Both are derived, never stored.
- **Assessment.** In 1.0 the output schema alone assesses a deliverable: `pass` (it matched),
  `fail` (it did not), `not_assessed` (no schema). The verdict `uncertain` is reserved for
  judging (§15). A deliverable that fails its schema raises a notice.
- **A run's result** is its whole deliverable, `structured` (the deliverable parsed against the
  output schema), its activity log (each tool call's name, whether it succeeded, why not, and
  how long it took, in call order; never its input or output), the files it wrote as the host
  reported them, and usage.
- **A batch** runs one task over many inputs, at most `concurrency` at once, under an optional
  `budgetUsd` and `stopWhen` rule (which needs an output schema). Validation is all or nothing.
  An item settles with `errorCode: "exceeds_share"` when a run of it holding the whole of what
  was left of the batch's budget stopped with `spendStop: "exhausted"`.
- **The screen** is two resources, MIME type `text/html;profile=mcp-app`: `ui://tasks/panel`
  (the scheduled-work page) and `ui://tasks/card` (the card shown under a `create` call). Its
  internals are the implementation's.

**Outputs.** A success carries its payload in `structuredContent`; a public tool also carries a
readable rendering in `content`. Every tool marked `unattended: "allowed"` is annotated
`readOnlyHint: true`.

- **Every private input and output, every shared schema, and every public input is closed**
  (`additionalProperties: false` at every level, enums closed). The host refuses what it does
  not know (§15).
- **Public outputs are open.** A client ignores a field it does not know. A value that names one
  of a set (`execution`, `label`, a batch's `state`, `verdict`, `pause.reason`, `errorCode`,
  `scheduleType`, `kind`, `trigger`, an item's `state`) is typed as a string whose description
  lists the values 1.0 defines, because a later minor may add one.
- **A client treats a value it does not know as unknown**: it shows it verbatim, never matches
  it to a known value, and takes none of the actions a known value would. In particular, a run
  whose `execution` it does not know is treated as ended (it stops polling it) and counted
  neither as succeeded nor as failed; a batch whose `state` it does not know is not acted on.
- **Public outputs require only a core** every implementation computes from the contract; every
  other field is optional:

| Tool | Required core |
|---|---|
| `create`, `update` | `task: { id, name, enabled, prompt }` |
| `delete` | `deleted`, `id` |
| `list` | `tasks[]: { id, name, enabled }`, `nextCursor` (null on the last page) |
| `status` | `task: { id, name, enabled, prompt }`, `recentRuns[]` (a run) |
| `run` | `runId`, `taskId` |
| `run_result` | `run`; `result: { completedAt, output }` when present |
| `runs` | `runs[]` (a run), `nextCursor` (null on the last page) |
| `cancel` | `cancelled`, `runId` |
| `upcoming` | `running[]: { taskId, runId }`, `queued[]: { taskId }`, `scheduled[]: { taskId, at }` |
| `stats` | `since`, `tasks[]: { taskId, runs, pass, fail }` |
| `run_batch`, `batch`, `batch_control` | `batch` |
| `batches` | `batches[]` (a batch) |

**Paging.** `list` and `runs` page by an opaque cursor: a client passes `nextCursor` back as
`cursor` with the same filters, unchanged, and never builds or parses one. The implementation
encodes its own position (for `runs`, newest first by `startedAt` with the run's id breaking a
tie), so a page holds at most `limit` entries and following the cursor never repeats or skips
an entry that existed when the first page was read; one added later MAY appear or be absent.
`batch` pages its items by index, which is already a total order.

A **run** requires `id`, `taskId`, `execution` and `label`, plus `startedAt` unless it is
`queued` and `completedAt` once it has ended; an `assessment`, when present, requires `verdict`.
A **batch** requires `id`, `taskId`, `state` and `counts` (every count). A batch **item**
requires `index` and `state`.

## 5. The run flow

The implementation decides **what** runs and **when it is due**; the host decides **when it
runs**, runs it, and enforces every limit. Nothing runs except through this flow.

### 5.1 Due

1. **The host calls `due({ version, until, cursor?, limit? })` for each workspace it
   serves**, as `host`, walled to that workspace, judged at the context's `now`. The answer is
   the occurrences in that workspace whose run the implementation has decided is owed and not
   yet begun, due at or before `until`, paged by an opaque `nextCursor` (`null` on the last
   page), and `cancel`, the runs to stop (§5.3). **The cursor carries the first page's `now`**,
   which the implementation stores in the cursor it mints, and a later page (sent with the
   same `until`) is judged at that instant whatever its own context's `now`, so one listing is
   judged at one instant. The host MUST call `due` for the workspace again before `until`
   passes.
2. **An occurrence is `{ key, ref, notBefore? }`.** `notBefore` is when it is due, absent for
   at once. `ref` is what `begin_run` is called with. `key` names the occurrence and its
   `notBefore` exactly: an occurrence whose time changes is a new occurrence with a new key,
   and the old one is skipped when it is claimed.
3. **The host enqueues each occurrence** on its work queue, scoped to the workspace, under
   `key`, not before `notBefore`. Enqueueing is idempotent per key, so the implementation lists
   an occurrence on every `due` until it is begun, and a repeat is one item.
4. **Retention.** On each `due` (its first page), the implementation removes the data of runs
   that ended longer ago than its configured retention, judged on the first page's `now`: their
   records, results and the idempotency keys that name them, and one-offs whose definition and
   newest run are older. It never removes an open run, a run of a batch that is not settled, or a
   one-off a batch names. The retention period is the implementation's configuration.
5. **The change hint.** The server declares the `resources.subscribe` capability. The host
   subscribes to `tasks://due/<workspaceId>` for each workspace it serves; reading that resource
   answers `{}`. When a workspace's occurrences change (a definition saved, a run asked for, a
   run cancelled, a batch moved), the server SHOULD send `notifications/resources/updated` for
   that URI, and the host then calls `due` for the workspace promptly. It is only a hint: the
   host also calls `due` on an interval, so a lost hint delays work, or a cancel, and loses
   none.
   - **Only `host` may read or subscribe**, and only to the URI of the workspace in its
     context. Any other principal, a URI of another workspace, or a call with no workspace is
     refused with JSON-RPC error `-32602` and `data.code` `"forbidden"`, and nothing is read or
     subscribed.

### 5.2 Begin

6. **A worker claims an item** and calls `begin_run({ version, ref, attempt, token })` as
   `host`, walled to the workspace, judged at the context's `now` (§6). `attempt` and `token`
   are the claim's.
7. **The implementation answers a skip or a run:**
   - `{ decision: "skip", reason, interrupted?, notices? }` for an occurrence that is no longer
     owed (the definition changed, was disabled or deleted, the run was cancelled while queued,
     a budget is spent). It records what its own records
     need, and the skip settles the item.
   - `{ decision: "run", runId, grant, work }`: the run's id, minted by the implementation, the
     definition's stored grant (§9), and the work spec (§7).
8. **Fencing is per `ref`.** The implementation keeps the highest `token` it has seen for each
   `ref`. `begin_run` is idempotent per (`ref`, `token`): a repeat answers the same decision,
   `runId`, `grant` and work spec. A `token` lower than one already seen for the `ref` fails
   `token_stale` and writes nothing.
9. **At most once.** When a higher token arrives for a `ref` whose run an earlier token already
   received, the implementation MUST NOT answer that run again. It records the run as
   interrupted, provisionally, and answers `skip` with `interrupted: { runId, token }` (the
   earlier token). The host then stops that run if it still runs, and ends it with `end_run`,
   `stopReason: "error"`, `error: { code: "interrupted", transient: true }` and the usage and
   cost its metering recorded for the run, which closes the record, its budget and its notices.
   That host never saw the run start, so the record keeps the context `now` of the
   `begin_run` that answered it as its start, whatever the outcome's `startedAt` says.
   A scheduled run that crashed after `begin_run` is recorded, never run again: running it
   again would repeat what it already sent or wrote.

### 5.3 Run

10. **The host checks the answer, then runs the work through its door** (§7). It refuses work
    it cannot honour in full, verifies the grant (§9), refuses a run whose `exclusiveKey` is
    held, admits it under fair share, and executes it as the grant's owner, in the workspace,
    walled to that workspace's tools and the owner's own. A run refused here still ends: the
    host calls `end_run` with the answer's `runId`, `stopReason: "not_started"` and the reason
    in `error`.
11. **A host whose claim on the item is lost MUST stop the run.**
12. **Cancel is a change, carried by `due`.** `due`'s `cancel` lists the runs in the workspace
    the host should stop: runs the host has begun (a `begin_run` answered them with a run) and
    whose `end_run` has not landed, never any other id. The implementation lists a cancelled
    run on every `due` until the host's `end_run` for it lands, so a missed answer is repeated,
    and every page of one listing carries the whole list. The list has no fixed cap: it is
    bounded by the runs the host has in flight in the workspace, which the host's own admission
    bounds, so it is never longer than the host can hold. Cancelling sends the change hint
    (§5.1), so the host calls `due` promptly. The host stops each listed run it holds, and that
    run ends with `stopReason: "cancelled"`. A run not yet begun is cancelled in the
    implementation's own records, and its claim is skipped.

### 5.4 End

13. **The host calls `end_run({ version, runId, token, outcome })`** once the run ends, however
    it ended (§8), with the token whose `begin_run` answered the run. The implementation records
    the run, derives its execution, label, assessment and failure streak, decides the next
    occurrence (a backoff, a retry, a batch's next item), and answers `{ notices }`.
14. **`end_run` is first-wins.** The first `end_run` accepted for a run stands and replaces a
    provisional interrupted record. A later one with the same token (a retry, or a dying worker
    racing the host's `interrupted` report) records nothing and answers the first's notices.
    Any other token fails `token_stale`. An `end_run` for a run `begin_run` never answered
    fails `run_not_found`.

### 5.5 One run per task

The implementation names the key that excludes concurrent runs (`exclusiveKey`, opaque to the
host), typically one per task; a batch's runs name none or keys of their own. The host runs at
most one run per key per workspace at a time, across every process. The implementation decides
what a refused run (`not_started`, `exclusive_busy`) means for its records.

### 5.6 Events

A workspace admin's route names a task; the host offers each notification that reaches the
route with `offer_event({ version, taskId, event })`, as `host`, walled to the workspace and
the route's author (the task's owner), judged at the context's `now`. The event carries its
presentation only (`id`, `source`, `name`, `level`, `title`, `subject`, `body`,
`receivedAt`), never the connector's data.

- **`{ accepted: true }`** means the implementation recorded the event durably before it
  answered. **`{ accepted: false, outcome, classification, reason }`** refuses it: `skipped` for
  a condition that clears on its own (the task is off, or its `match` does not want it),
  `denied` for a configuration only a person changes. `classification` is machine-readable
  diagnosis and decides nothing. Either answer MAY carry `notices`.
- **A burst is one run.** An accepted event joins the task's pending event occurrence, due at
  the context `now` of the first event's `offer_event` plus the task's `debounceMs`. Events
  are deduplicated by (`source`, `id`) for at least the run-retention period. The run carries
  them in its work spec's `notes`.
- **The fire ceiling ends a loop.** A task that would pass `maxFiresPerHour`, counted on the
  context's `now`, is disabled and the event refused.

### 5.7 Workspace deletion

**`delete_workspace({ version })`** purges every owner's tasks, grants, runs, batches and keys
in the workspace, and any storage held for it. Idempotent.

## 6. The clock rule

**Every instant the implementation decides on or records is the context's `now`, or an
argument naming a horizon or a past instant**: `due`'s `until`, the outcome's `startedAt` and
`endedAt`, an event's `receivedAt`, a schedule's `at` and a read's `since`. It MUST NOT read
a clock. The host stamps `now` on every call (`contracts/host-context/CONTEXT.md` §2), so every
decision is the host's clock and a stated `now` reproduces it.

- **A schedule saved or changed is anchored on the `now` of the next `due`** for its workspace:
  that call computes its first occurrence.
- **A once already past is refused at write.** `create` and `update` fail `invalid_input` for
  an `at` at or before the call's `now`: it could only be missed. A later `at` is judged on the
  `due` that would list it, as any once is.
- **Retention is judged on the first page's `now`** (§5.1).
- **Budget periods are UTC calendar days and months**, judged on the call's `now`.
- **Lateness, backoff and the fire ceiling** are judged on the `now` of the call that decides
  them. A once's lateness is judged only on the `due` that would list it: past its grace
  there, it is recorded missed and not listed; once listed, it is owed, and `begin_run` never
  skips it as late however long the host's queue held it.
- **Records and reads use the call's `now`**: `createdAt` and `updatedAt`, a run's
  `requestedAt`, `upcoming`'s window and `stats`' default `since`.
- The host's queue alone is the timer: `notBefore` is the only way the implementation delays
  work.

## 7. The work spec

`begin_run`'s run answer is `{ decision: "run", runId, grant, work }`. `runId` and `grant` sit
beside the work, not in it: they are what the host needs whatever the work is (to report the
run and to know whose it is), so a host refusing work it does not understand can still end the
run. `work` is `work_spec`, a closed union on `kind`. **Version 1.0 has one kind, `agent`**: an
agent run through the host's door. Every level is closed.

| Field | Required | Meaning |
|---|---|---|
| `kind` | yes | `"agent"` |
| `prompt` | yes | The instruction that opens the run; empty only with `skills` |
| `input` | no | JSON, at most 64 KiB serialized. The host wraps it in containment: data, never instructions |
| `notes` | no | Up to 8 strings of context for this run (an event's items, a retry's reason), contained like `input` |
| `outputSchema` | no | The JSON Schema the deliverable must match; the host renders the instruction |
| `allowedTools` | no | Tool name globs the run is narrowed to, matched by the host |
| `skills` | no | Up to 5 skill names, given in full before the first model call, resolved by the host |
| `limits` | no | `{ maxIterations?, maxInputTokens?, maxRunDurationMs? }`; the host lowers each to its ceiling |
| `model` | no | `provider:model-id` or a slot name |
| `thinkingEffort` | no | `low`, `medium`, `high`, `xhigh` or `max` |
| `spendAccounts` | no | Up to 8 of `{ id, unit, remaining, sharedBy? }` (below) |
| `exclusiveKey` | no | At most one run per key in flight in the workspace (§5.5) |
| `trigger` | no | `scheduled`, `manual` or `event`: telemetry only |

- **Containment and the output-schema instruction are the host's.** The implementation passes
  data and a schema; it never writes prompt text that wraps them.
- **A host refuses, never ignores, work it does not fully understand**: a `kind` or a field it
  does not know ends the run, through `end_run` with the answer's `runId`, as `not_started` with
  `error.code: "work_invalid"`.

**Spend accounts.** The implementation owns its budgets (a task's token budget, a batch's
`budgetUsd`); the host enforces them.

- Each account is `{ id, unit, remaining, sharedBy? }`: `id` opaque to the host, `unit` one of
  `usd`, `input_tokens`, `output_tokens`, `remaining` at least 0. Runs in flight that name the
  same `id` draw on one live balance; `sharedBy` is the most runs that may draw on it at once.
- **The host's own accounts apply to every run** (operator ceilings, a tenant's quota) whatever
  the work names. An implementation's account can only lower what a run may spend, never raise
  it.
- The host stops a run with `spend_limit` before a call the balances cannot pay for, and says
  which account and why (`spendAccountId`, `spendStop`).
- **The host releases an account only after `end_run` for the run is acknowledged**, so the
  implementation's next balance always includes the run's cost. An interrupted run is charged
  through the `end_run` the host sends for it (§5.2).

## 8. The outcome

`end_run`'s `outcome` is `run_outcome`, the one schema every implementation receives, so it is
closed at every level and small: what only the host observed. The implementation derives
everything else.

| Field | Required | Meaning |
|---|---|---|
| `startedAt`, `endedAt` | yes | The host's instants (§6) |
| `output` | yes | The deliverable, the final answer's text; empty when none |
| `stopReason` | yes | `complete`, `max_iterations`, `max_input_tokens`, `spend_limit`, `length`, `content_filter`, `timeout`, `cancelled`, `error`, `other`, `not_started` |
| `error` | see below | `{ code, transient, message? }` |
| `usage` | yes | `{ inputTokens, outputTokens, iterations? }` |
| `costUsd` | yes | What its model calls cost |
| `toolCalls` | yes | `{ name, ok, errorReason?, ms }[]`, in call order, at most 1000 |
| `filesWritten` | yes | `{ uri, name? }[]`, opaque references the host recorded, at most 100 |
| `wrapUpLimit` | only with `complete` | `max_iterations` or `max_input_tokens`: the limit the host told the run to finish at |
| `unpricedCalls` | no | Model calls with no known rates, not in `costUsd` |
| `spendAccountId` | only with `spend_limit` | The account that stopped it (one the work named, or the host's own) |
| `spendStop` | only with `spend_limit` | `exhausted` (the balance could not pay) or `reserved` (other runs' reservations held what was left) |
| `limits` | no | `{ maxIterations?, maxInputTokens?, maxRunDurationMs? }`, the caps it ran under after the host's ceilings |
| `skillsDelivered` | no | `{ name, loadedBy, status? }[]`; `loadedBy` and `status` are diagnostic strings |

The schema encodes each pairing: **`error` is required with `error`, `other` and `not_started`,
and not allowed with `complete`**; `wrapUpLimit` only with `complete`; `spendAccountId` and
`spendStop` only with `spend_limit`.

- **`error.code`** is one of `grant_invalid`, `membership_revoked`, `exclusive_busy`,
  `tools_unavailable`, `skills_unavailable`, `work_invalid`, `spend_limit` (refused before its
  first call), `model_error`, `interrupted`, `internal`. `transient` is the host's verdict on
  whether the same run may succeed later unchanged.
- **A host shutdown is not a cancel.** A run the host stops because it is shutting down ends
  `error` with `internal` and `transient: true`; `cancelled` means only that `due` listed it.
- **A `not_started` run made no model call.** `exclusive_busy` clears on its own, and an
  implementation MUST NOT count it toward a failure streak. **`grant_invalid` and
  `membership_revoked` disable the definition at once**, not through the streak, and the
  implementation answers a notice: the grant no longer admits runs, and the next grant-marked
  call that names the definition (§9) both re-stamps it and, with `enabled: true`, enables it.
- **`errorReason`** is one of `bad_input` (rejected for its arguments), `tool_error` (answered an
  error), `denied` (refused by policy), `timeout`, `unavailable` (could not be reached). A call
  that ran nothing is left out of `toolCalls`.
- **Tool calls carry no input and no output**, and files are what the host reports, never parsed
  from another server's tool output.

## 9. Run grants

A run acts for its owner with no person present, so the host needs the owner's standing
authority, recorded when the owner set the work up. The mechanism is the host-context spec's
(§6 there); for this contract:

- **`create`, `update`, `run`, `run_batch` and `batch_control` carry `grant: true`**, so the
  host stamps a grant on every `person` call to them. Each is `refused` unattended, so a call a
  run makes never carries one. A call to one of them with no grant fails `grant_missing` and
  writes nothing.
- **The grant is the host's**: signed by the host over the contract, `workspaceId` and
  `ownerId`, in a format opaque to the implementation.
- **The implementation stores it with the definition and re-stamps it**: every grant-marked call
  that names a definition (`create` and `update` by saving it, `run` and `run_batch` by running
  it, `batch_control` by acting on a batch of it) replaces the definition's stored grant with
  the call's. `delete` drops it with the definition.
- **It returns the stored grant verbatim in `begin_run`'s run answer**, and nowhere else: no
  public output, notice, log or error carries it.
- **The host verifies it before admitting a run**: the signature against its signing key, that
  it names this contract and the workspace, and that its owner is a member of the workspace now.
  The run acts as the grant's owner. A grant that fails ends the run `not_started` with
  `grant_invalid` or `membership_revoked`. When the host's signing key changes, every stored
  grant fails `grant_invalid` until a grant-marked call re-stamps its definition.
- **Threat model.** The implementation is trusted with every grant it holds. A grant stops
  forgery (no person, agent or implementation can mint one for another owner, workspace or
  contract) and self-propagation (no unattended run ever receives one, so a run cannot set up
  more work under anyone's authority). It does not bind what runs: an implementation can pair
  any grant it holds with any work in that workspace. What it may run is bounded by the owner's
  membership and the host's door, not by the grant.

## 10. Unattended calls

- Every tool is marked `unattended: "allowed"` or `"refused"`. The tools that author, start or
  stop work (`create`, `update`, `delete`, `run`, `cancel`, `run_batch`, `batch_control`) are
  `refused`, so a run that reads untrusted content cannot rewrite, multiply or cancel work that
  outlives it. The reads are `allowed`. Every private tool is `refused`.
- **The host never offers a `refused` tool to a run**, and stamps `unattended: true` on every
  call a run makes.
- **The server refuses a `refused` tool on a call with `unattended: true`** with
  `unattended_refused`, and changes nothing.
- **A definition never lists a `refused` tool alone** in `allowedTools` (§4), so the person
  setting it up learns then, not from a run, that a run cannot author, start or stop work.

## 11. Notices

Notices are how the implementation tells a workspace that something about a task needs
attention (a run failed, a task was disabled, a batch paused, a deliverable failed its schema).
They come back on `end_run`, on a `begin_run` skip, and on `offer_event`; the implementation
keeps no outbox. A notice is `{ id, title, body, level }`, `level` one of `info`, `attention`,
`urgent`.

- **The host delivers each notice to the workspace's inbox**, once, deduplicated on (contract,
  workspace, `id`) for at least the run-retention period, so a repeated `end_run` delivers
  nothing twice.
- **A notice carries nothing a member of the workspace may not read.** The inbox is the
  workspace's and a task is private to its owner, so a notice names the run and the owner by id
  and says what happened, never the task's name, prompt, input, output or error text; the
  detail stays on the run, which only its owner can open.

## 12. Errors

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
  transport's; a refused read of or subscription to the hint resource is §5.1's.

## 13. Idempotency and fencing

- **`run` and `run_batch` take an `idempotencyKey`.** A repeat with the same key in scope
  answers what the first call asked for (`existing: true`) and asks for nothing; a repeat
  whose inline definition differs fails `conflict`. A key lasts as long as the run or batch it
  names.
- **Occurrence keys** make enqueueing idempotent (§5.1). **Tokens** fence `begin_run` per `ref`
  and `end_run` per run (§5.2, §5.4). **Notice ids** make delivery idempotent (§11).
- `create` refuses an id that exists. `delete` and `delete_workspace` are idempotent by their
  answers.

## 14. Never in the contract

- **The medium.** No path, file handle, offset, query, table, or bucket or object key crosses
  the contract.
- **The host's machinery.** No queue position, admission key, lease, worker, slot or ceiling
  crosses it; `upcoming` lists what is queued and running without positions.
- **The grant's contents**, and the grant anywhere but `begin_run`'s run answer.
- **Other servers' data.** A tool call's input and output, a connector's notification data,
  and another server's tool output never reach the implementation.
- **Prompt text the host wraps around data**: containment and the output-schema instruction.
- **Pricing and usage metering**, which stay the host's; the implementation records the
  `costUsd` the outcome reports.
- **Credentials and the carriage of the context**, which the host-context spec owns.

## 15. Versioning

- The version is `major.minor`. The document's URL names the major (`…/tasks/v1/…`).
- **The same major is compatible.** An implementation at `M.m` meets a need for `N.n` when
  `M = N` and `m >= n`. A host states the minor it needs and refuses an implementation below
  it.
- **A minor only adds**: an optional input field, an output field, a tool, an error code, a
  resource, a work `kind`, a value of a public output's string set (§4), or a value of a closed
  enum the host or implementation sends under the rule below.
- **Versioning holds both ways.** Every private input carries the host's `version` of this
  contract. An implementation MUST NOT answer a decision, a work `kind`, a work-spec field, an
  occurrence field or a spend `unit` that version does not define, and a host MUST refuse what
  it does not know (§7). The host likewise sends an implementation only the `stopReason`,
  `error.code` and `errorReason` values its declared minor defines, mapping a newer one to
  `other`, `internal` or `tool_error`.
- **Anything else is a new major**, at its own URL beside this one.
- **Planned minors.** *Judging*: acceptance criteria and a judge on a definition, the `assess`
  and `judges` tools, a `call` work kind through which the host runs the judge's call, a
  person's verdict, and the verdict `uncertain` in use. *Poor-result policy*: `onPoorResult`
  (record, notify, retry once) on a definition; until then a deliverable that fails its schema
  raises a notice. None of it is in 1.0.

## 16. Conformance

The conformance runner (`runner/conformance.ts`) speaks only MCP to an implementation and reads
only this document. An implementation is conformant when it holds every rule this file states;
the runner checks at least:

- every tool's schemas, the walls, and the principal rule (each private tool answers a
  `person` with `forbidden`);
- the hint resource: `tasks://due/<workspaceId>` reads `{}` and accepts a subscription from
  `host` for its own workspace, and refuses (`-32602`, `forbidden`) another principal and another
  workspace's URI;
- the unattended rule, `grant_missing` on every grant-marked tool, and `invalid_input` for an
  `allowedTools` entry that names only `refused` tools;
- that a grant never appears outside `begin_run`'s run answer;
- the clock rule, with a stated context `now` on every call: `scope_missing` without one,
  retention on `due` included, a later `due` page judged at the first page's instant, a once
  at or before the call's `now` refused, and records stamped with the call's `now`;
- cancel: a cancelled run that `begin_run` answered appears in `due`'s `cancel` on every call
  until its `end_run`, and no id outside those runs ever does;
- fencing: `token_stale` on a lower token, the same answer for a repeated (`ref`, `token`), and
  first-wins `end_run`;
- **at most once**: after a run is answered for a `ref`, a later token never receives that run,
  and is answered `skip` with `interrupted`;
- that every answer the host reads is valid against its closed schema at the stated `version`.

The document is also held by unit tests: it compiles whole as JSON Schema 2020-12, every
`$ref` resolves, the shared `$defs` exist and only private tools refer to them, `grant` sits
only on public tools refused to unattended runs, the outcome's pairings hold, and the input
schedule is exactly one of its forms.

Generate types for another language from the document's `$defs`; never write them by hand.
