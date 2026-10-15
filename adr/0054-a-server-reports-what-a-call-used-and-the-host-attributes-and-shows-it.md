# 0054. A server reports what a call used; the host attributes it and shows it

- Status: Proposed
- Date: 2026-10-14
- Serves: orchestrate remote MCP

## Context

The usage ledger records one line per priced model call, written at the point of
spend (`recordLlmCall`), and the usage report and its page read only those
lines. Model tokens and their cost are the whole picture a tenant sees.

A tool call uses things too, and the runtime cannot see them. A search server
asks its provider for a request and some number of results. A fetch server
renders pages, and renders some of them a second time with another source when
the first comes back empty. A research server starts a run that searches and
reads on its own for minutes. An enrichment server spends one lookup per record,
and a second only when the first is inconclusive. A judge runs a model and
counts its tokens. Several of those providers return a figure for what the call
used, and the server discards it, because MCP gives it nowhere to send it. So
"how much did this run use" counts the model and nothing else.

Two facts decide where the parts go:

- **Only the server knows what a call used.** A host-side table of per-tool
  quantities is a guess, right only when every call does the same work.
- **Only the host knows who the call was for.** The user, the workspace, the run,
  and whatever business object the run was about are in the host's hands when
  the result arrives, and nowhere else. The server does not need them and should
  not be sent them.

People ask usage questions across runs, not only within one: what one customer
record took to process when five separate runs touched it, what one campaign
took, what one batch took. The kernel cannot know what a customer record or a
campaign is, and every kernel field added for one would be followed by a field
for the next.

How the things a server uses are bought differs by provider: per request, per
result, from a prepaid credit balance, from a monthly allowance, on a flat
subscription. Those purchases happen on each provider's own platform, outside
the runtime and often outside the server. A common price across them is a
separate question from counting them, and this decision answers only the second.

MCP defines no way for a server to report usage, and nothing like it is proposed
upstream. A result's `_meta` takes vendor-prefixed keys, and ADR-0024 settles
how ours are named and when one is accepted from a server.

## Decision

**A server reports what a call used, per meter, in the result's `_meta` under
`ai.nimblebrain/usage`. The host attributes each entry to the call's user,
workspace, and run, records it in the usage ledger, and shows it beside model
usage. Nothing here limits, prices, or charges a call.**

### The report

A tool result, success or `isError`, may carry one report: a list of entries,
one per meter the call used. A call that draws on several sources reports one
entry for each.

```jsonc
"_meta": {
  "ai.nimblebrain/usage": {
    "id": "01JZ8Q4M7T3W5K9X2B6D0HVRNC",
    "items": [
      { "meter": "search.request", "quantity": "1", "unit": "request",
        "status": "final" },
      { "meter": "search.result", "quantity": "10", "unit": "result",
        "status": "final",
        "amount": { "value": "0.0050", "currency": "USD" } },
      { "meter": "page.render", "quantity": "3", "unit": "page",
        "status": "estimated" }
    ]
  }
}
```

| Field | Rule |
|---|---|
| `id` | Server-minted, unique per server, and the same whenever the same work is reported again. The host ignores a report whose `id` it has already recorded from that server for the same run. |
| `items` | One to 16 entries. A call that does the same kind of work many times (ten URLs, ten variants) reports one entry with the sum, not one per item. |
| `items[].meter` | A name for what was used, from a shared vocabulary of dotted names (`search.request`, `email.validation`, `model.input`). It never names an upstream vendor, a vendor's product, or a vendor's unit, so swapping the provider behind a tool keeps its meters. |
| `items[].quantity` | A non-negative decimal string. `"0"` reports a call that used nothing on that meter, which differs from no report. |
| `items[].unit` | What one of `quantity` is: `request`, `result`, `page`, `token`, `check`. A provider's own credit is not a unit: credits differ between providers, so the server reports the thing it asked for. |
| `items[].status` | `final` when the figure is what the provider said the call used; `estimated` when the server counted it itself, such as a request that may have been retried or that timed out after the provider started it. |
| `items[].amount` | Optional: what the provider said the entry cost, as `value` (a non-negative decimal string) and `currency` (ISO 4217, no default). A server passes it on only when the provider returned it, and never derives it from a rate. |

A report never carries a negative number. A call's usage is its entries; the
report carries no total.

**The shape is a published JSON Schema, canonical in this repo, and the host
validates every report against it**, so the rules above and the host's check
cannot drift apart. Types for the host and for servers are generated from the
same file. The host ignores a field the schema does not know, so a newer server
works against an older host; a malformed known field drops the whole report; a
change that breaks either side takes a new identifier (ADR-0024).

A report describes its own hop. A server that called other servers reports what
it used, never the reports it received.

The host asks for reports by sending `_meta: {"ai.nimblebrain/usage": {}}` on
each `tools/call`, because the connections the host speaks on do not all carry
negotiated extensions. A server sends a report only to a request that asked: a
client that did not may put `_meta` where a model reads it.

**A task-augmented call reports on the result it completes with** (ADR-0046),
not on the task handle, because what a long call used is known only when it
ends. The host reads it when it reads the outcome, and attributes it to the call
that started the task.

**Only what a call does is reported.** Work a server does on its own schedule
(reconciling orders, mirroring lists) has no call and no attribution, and a
subscription, a plan fee, or a credit top-up is not usage of a call. Those stay
in the provider's records.

### What the host does with it

- **It is accepted from the wire, and bounded.** By ADR-0024's test, accepting
  it widens nothing: it grants no authority and changes no behaviour, and a
  server that misreports misreports its own usage, through a server the
  workspace chose to connect. The host validates the report against its schema
  and drops a malformed one entirely. Every string in it is the server's,
  displayed as text, never interpreted.
- **It never reaches a model.** The model's view of a result is built from
  `content`, and the report is read only by the host. The host's own MCP
  endpoint does not forward a server's `_meta` to the client that called it.
  Both hold today by omission, so tests pin them: a report appears in neither
  the model's view of a result nor the endpoint's response.
- **Each entry becomes a ledger line.** The ledger entry gains a discriminator
  between a model call and a tool report, and a line written before it reads as
  a model call. A tool line carries the server and tool names, the report's `id`
  and the entry's position in it, the entry as received, the receipt time, and
  the same attribution a model call's line carries.
- **It is auditable without naming the provider.** The ledger line keeps the
  report's `id` and the call's trace id. The server logs the provider's
  reference for the call (the request or run id the provider returned, or one
  the server set on the request) with the report's `id`, and with the trace id
  when the connection carried trace context, which not every connection does.
  It never sends that reference to the host, because a provider's reference
  identifies the provider. An operator follows a ledger line to the server's
  log, and from there to the provider's records. That path exists only for
  servers whose logs the operator can read; for any other server, audit ends at
  the ledger line.
- **Telemetry gets a copy, never the record.** The host records each entry as
  attributes on the call's span, and counts reports in its metrics by server
  and status only: `meter` and `unit` are the server's strings, so they never
  become metric labels. Traces are sampled and expire, so nothing reads usage
  back from them. Labels never travel as trace baggage, which reaches every
  server downstream.
- **No report is unknown, not zero.** The host records nothing for a call
  without one, and shows, per server, whether it reports at all.

### Attribution: a run carries labels

**A run's description may name labels: at most 8, each key at most 64
characters of lowercase letters, digits, `.`, `_` and `-`, each value at most
256 characters. The source starting the run chooses them, the door refuses a
description whose labels are out of bounds, and the kernel stamps them on every
ledger line the run produces, model and tool alike, without interpreting
them.** This is the shape spend accounts already have: the source names ids, and
the door never reads their meaning.

The source that knows what a run is about sets them. A task names its task and
its batch, and a task definition may map fields of its input to labels, so every
run over one customer record carries the same value, and that record's usage is
one filtered read of the ledger across any number of runs and tasks. A
definition that maps fields is refused when it is written unless each mapped key
meets the key rule, the mapped keys and the labels the task sets itself fit
within the count, and each field's input schema bounds it to a string within the
value limit, so no input that passes the task's schema can produce a run the
door refuses. A conversation names none. Totals are computed on read by
filtering and grouping on labels; nothing is rolled up in advance.

A call made on a run's behalf after it ends, such as the assessment of its
deliverable, carries that run's labels.

### How it is shown

Usage is read through the usage report, so every view that reads it gets tool
usage the same way:

- **Meters are a dimension beside models.** The report groups tool lines by
  server and meter, and can group any line by a label key. A quantity is summed
  only within one meter and unit, never across them: ten searches and four
  thousand tokens do not add up to anything.
- **Cost is shown where a figure exists, and its absence is shown.** Model cost
  is what it is today. A tool entry with an `amount` shows it, marked as
  reported by the provider; one without shows its quantity and unit only. A
  total that includes tool cost says how many entries it could not price,
  as model cost already does for unpriced calls.
- **Every place that shows a run's tokens shows its meters**: the usage page,
  per workspace and for the org, a task run's result, and a batch. The page
  also lists which connected servers report usage, so a server that reports
  nothing reads as unknown rather than free.

### Not decided here

Each is its own decision, taken when something needs it:

- **A common unit across meters**, such as a credit the host defines with a
  conversion factor per meter. Lines keep their meter, unit, and quantity, so a
  factor can be applied to past usage without rewriting it.
- **Limits and budgets on tool usage.** Spend accounts (ADR-0045) budget model
  calls only.
- **What a tenant is charged** for tool usage, if anything.
- **A report that settles after the call** (a pending figure and a way to fetch
  the final one), and a correction to one already recorded.

The identifier is ours; it changes only if a shared shape is standardized, which
needs other implementations first.

## Consequences

- A run, a batch, a workspace, and the org show what their tool calls used, not
  model usage alone, and a tenant can see which servers report nothing.
- Usage per business object needs no kernel concept of the object. Whether it
  adds up depends on authors labelling consistently: two tasks that name the same
  record under different keys produce two totals that never meet. The task
  authoring guide has to say so.
- Meters only compare across servers if servers share names. The vocabulary is
  published beside the schema, and a server that invents a name is still
  recorded and shown, under its own name.
- The ledger grows by one line per reported entry. It stays a display surface,
  not a billing record.
- Every report is the server's claim. A server that misreports is answered by
  disconnecting it; nothing in this design proves a figure.
- A third-party server can report without reading our source, and a server that
  reports nothing is unaffected.

## Alternatives considered

- **A host-side table of per-tool usage.** Wrong for any tool whose work varies
  with its arguments or outcome, which is most of them.
- **Server telemetry joined on trace id.** Works only when the host operator also
  runs the server's collector, and still needs a join to reach the attribution
  the host held at the moment of the call.
- **Report money, not usage.** Most providers report units and many report no
  price, and a price is a fact of a purchase the server may never see. Units are
  what every call can report; money rides along where a provider gives it.
- **Report the provider's credits as the unit.** Credits from different providers
  are different units, and naming them names the provider.
- **Attribution as ledger fields (`batchId`, `subject`, ...).** Each grouping a
  kernel field, each a concept the kernel should not know.
