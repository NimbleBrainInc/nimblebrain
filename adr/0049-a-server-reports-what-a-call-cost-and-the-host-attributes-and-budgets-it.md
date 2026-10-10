# 0049. A server reports what a call cost; the host attributes it and budgets it

- Status: Proposed
- Date: 2026-10-06
- Serves: orchestrate remote MCP

## Context

The usage ledger records one line per priced model call, written at the point of
spend (`recordLlmCall`). Spend accounts reserve before each model call and debit
after it (ADR-0045). Both see model calls only.

A tool call can cost money too, and the runtime cannot see it. A search server
on a platform-held key pays its provider per request, and the amount varies with
the arguments. A server that runs its own model pays for tokens. A server that
consults a second paid source only when the first is inconclusive costs a
different amount for the same arguments, and sometimes nothing. Many such
providers return a per-call figure in their own responses, and the server
discards it, because MCP gives it nowhere to send it. So a run's cost, a batch's
cost, and a `usd` budget all count the model and nothing else, and a budget a
person reads as a ceiling on spend is a ceiling on part of it.

Two facts decide where the parts go:

- **Only the server knows what a call cost.** A host-side price table is a guess
  about someone else's bill. It is right only for a fixed per-call price.
- **Only the host knows who the call was for.** The user, the workspace, the run,
  and whatever business object the run was about are in the host's hands when
  the result arrives, and nowhere else. The server does not need them and should
  not be sent them.

People also ask cost questions across runs, not only within one: what one
customer record cost to process when five separate runs touched it, what one
campaign cost, what one batch cost. The kernel cannot know what a customer
record or a campaign is, and every kernel field added for one would be followed
by a field for the next.

MCP defines no way for a server to report usage or cost, and nothing like it is
proposed upstream. The protocol leaves room for one: a result's `_meta` takes
vendor-prefixed keys, and ADR-0024 settles how ours are named and when one is
accepted from a server.

## Decision

**A server reports what a call consumed in the result's `_meta`, under
`ai.nimblebrain/usage`. The host attaches attribution, records the cost on the
ledger, and debits it from the run's spend accounts.**

### The report

A tool result, success or `isError`, may carry one report:

```jsonc
"_meta": {
  "ai.nimblebrain/usage": {
    "id": "01JZ8Q4M7T3W5K9X2B6D0HVRNC",
    "status": "estimated",
    "payer": "server",
    "usage": [
      { "meter": "search.request", "quantity": "1",  "unit": "request" },
      { "meter": "search.result",  "quantity": "10", "unit": "result" }
    ],
    "amount": { "value": "0.0070", "currency": "USD", "basis": "cost" }
  }
}
```

| Field | Rule |
|---|---|
| `id` | Server-minted, unique per server, and the same whenever the same work is reported again. The host ignores a report whose `id` it has already recorded from that server for the same run, so the check reads one run's lines, not the ledger. No current path delivers a report twice; the `id` is what keeps a later one safe, such as resuming a task-augmented call, which ADR-0029 leaves undecided. |
| `status` | `final`, or `estimated` when the server's own source says its figure is not a bill. |
| `payer` | `server` when the server paid on its own account; `caller` when it ran on credentials the caller supplied. A `caller` report is shown and never debited. |
| `usage` | One or more `{meter, quantity, unit}`. `meter` is a name the server chooses for what was consumed, and never names an upstream vendor, a vendor's product, or a vendor's unit. `quantity` is a non-negative decimal string; `"0"` is a valid report of a call that consumed nothing, and is different from no report. |
| `amount` | Optional. `value` is a non-negative decimal string, `currency` an ISO 4217 code with no default. `basis` is `cost` when it is what the server paid for this call, or `price` when it is what the server charges its caller; either way it is what the call cost the host, and the host records it as cost. A server may withhold `amount` and report units only. |

A report never carries a negative number. A refund or a correction is a separate
decision (below), and a report that tries to express one is malformed.

### Credits, prepaid balances, and what nobody here can see

The accounts behind a server's provider are bought and managed on the
provider's own platform: credits topped up, plans changed, keys rotated. None of
that passes through the runtime or the server, and neither can assume it knows
what was paid. What each side can know:

- **At the call, the units are always knowable.** A server knows what it asked
  for (one request, ten results, one lookup), and many providers also return
  what the call drew (credits, tokens). A call that draws on a prepaid balance
  reports it in `usage`: `{"meter": "email.validation", "quantity": "1",
  "unit": "credit"}`. **A credit is a unit, never a currency.**
- **Money is knowable at the call only when the provider says so.** Some
  providers return a per-call dollar figure; the server passes it on as
  `amount`, `status: estimated`. A server never derives `amount` from a rate it
  was not given: a credit's price is a fact of a purchase the server never saw.
- **The rate is an operator's estimate, held by the host.** An operator who
  knows roughly what a credit costs (from the provider's dashboard or invoice)
  sets a cost rate per server and meter in the host's operator configuration.
  It lives there because it describes an account the host's operator manages,
  it can change without redeploying any server, and it prices a third-party
  server's units the same way as ours. The host applies it when the line is
  written, to a line that carries units and no `amount`, and marks the line's
  cost as estimated from that rate. A provider-reported `amount` takes
  precedence.
- **With no amount and no rate, a line is unpriced, not free.** It shows its
  units ("1,240 credits") and counts as unpriced spend on every total it is part
  of, and it debits no money account.
- **Purchases are not ledger lines.** Topping up a balance, a plan's monthly
  fee, an allowance included in a subscription: none has an originating call,
  so none is attributed to a run. They are reconciled outside the runtime, by
  comparing what a provider invoiced with the units the ledger recorded against
  its meters. That comparison is also how a rate is set or found wrong.

Because every line keeps its units, a wrong rate is corrected by re-pricing the
affected lines on purpose, never as a side effect of reading.

A report describes its own hop. A server that called other servers reports what
this call cost its caller, never the reports it received.

The host asks for reports by sending `_meta: {"ai.nimblebrain/usage": {}}` on each
`tools/call`, because the connections the host speaks on do not all carry
negotiated extensions. A server sends a report only to a request that asked: a
client that did not may put `_meta` where a model reads it.

### What the host does with it

- **It is accepted from the wire, and bounded.** By ADR-0024's test, accepting
  it widens nothing: with every number non-negative, a server that over-reports
  makes its own tenant's budget stricter and its own cost higher, both through a
  server the workspace chose to connect; one that under-reports or claims
  `payer: caller` is no worse than reporting nothing. The host validates the
  report whole (entry count, string lengths, non-negative decimal grammar,
  currency) and drops a malformed one entirely. Every string in it is the
  server's, displayed as text, never interpreted.
- **It never reaches a model.** The model's view of a result is built from
  `content`, and the report is read only by the host. The host's own MCP
  endpoint does not forward a server's `_meta` to the client that called it.
  Both hold today by omission, so tests pin them: a report appears in neither
  the model's view of a result nor the endpoint's response.
- **It becomes a ledger line.** The ledger entry gains a discriminator between a
  model call and a tool report, and a line written before it reads as a model
  call. A tool line carries the server and tool names, the report as received,
  its cost (reported, or from an operator rate), the receipt time, and the same
  attribution a model call's line carries.
- **No report is unknown, not zero.** The host records nothing for a call
  without one, and shows, per server, whether it reports at all.

Cost is shown wherever model cost is shown today. What a tenant is charged, if
it ever differs from cost, is the host's to decide and never a server's; it
waits for its own decision (below).

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
run over one customer record carries the same value and the cost of that record
is one filtered sum over the ledger, across any number of runs and tasks. A
definition that maps fields is refused when it is written unless each mapped
key meets the key rule, the mapped keys and the labels the task sets itself fit
within the count, and each field's input schema bounds it to a string within the
value limit, so no input that passes the task's schema can produce a run the
door refuses. A conversation
names none. Totals are computed on read by filtering and grouping
on labels; nothing is rolled up in advance.

A call made on a run's behalf after it ends, such as the assessment of its
deliverable, carries that run's labels.

### Budgets

**A `usd` spend account is debited a tool line's cost after the call. A tool
call is not sent while any `usd` account its run holds is at or below zero; the
run ends with the spend-limit stop reason naming the account, as it does when the
door cannot pay for a model call.** Nothing is reserved before a tool call,
because nothing about its cost is known before it.

So the bound on overshoot is every paid tool call in flight when the balance
crosses zero, across every run that holds the account: a turn's tool calls run
in parallel, and a batch runs several runs on one account, so each of those calls
passes the check before any of them debits. **This amends ADR-0045 for tool
spend:** runs sharing an account cannot together exceed it in model spend, and
can exceed it in tool spend by that bound. Holding tool spend to the same
guarantee would need a check that serializes tool calls against the account; it
is not taken until an overshoot is measured that matters.

An unpriced line debits nothing, so a budget is only as complete as the reports
and rates behind it, and a run or batch shows its unpriced units beside its
total. Token-unit accounts are never debited by a tool line. They budget the
run's own model.

### Not decided here

Each of these is its own decision, taken when something needs it:

- What a tenant is charged when it differs from cost: a markup, per-meter
  rates, or credits a tenant buys from the host. Lines keep units and cost, so a
  price applied at write later rewrites nothing.
- A charge that settles after the call (a pending report and a way to fetch its
  final figure), a refund or correction, and a charge with no originating call.
- A price declared before a call, and a host-side estimate for servers that
  report nothing.

The identifier is ours; it changes only if a shared shape is standardized, which
needs other implementations first.

## Consequences

- A run's cost, a batch's cost, and a budget mean all spend that was reported,
  not model spend alone, and a tenant can see which servers report nothing.
- Cost per business object needs no kernel concept of the object. Whether it
  adds up depends on authors labelling consistently: two tasks that name the same
  record under different keys produce two costs that never meet. The task
  authoring guide has to say so.
- The ledger grows by one line per reported tool call. It stays a display
  surface, not a billing record.
- Every report is the server's claim. Over-reporting by a server the tenant
  connected is answered by disconnecting it; nothing in this design proves a
  figure.
- A third-party server can report without reading our source, and a server that
  reports nothing is unaffected.
- Tool spend reaches a budget after the calls that incurred it, so a budget can
  be overshot by every paid tool call in flight across the runs that share it.

## Alternatives considered

- **A host-side price table per tool.** Wrong for any cost that varies with
  arguments or outcome, which is the case that matters.
- **Server telemetry joined on trace id.** Works only when the host operator also
  runs the server's collector, and still needs a join to reach the attribution
  the host held at the moment of the call.
- **The server reports what the tenant is charged.** Puts each tenant's terms
  into every server, and cannot apply to a server we do not operate.
- **Attribution as ledger fields (`batchId`, `subject`, ...).** Each grouping a
  kernel field, each a concept the kernel should not know.
- **Reserving a tool call's cost before it.** Nothing about it is known before it;
  a reservation would be a guess dressed as a guarantee.
- **Cost derived on read from operator rates.** Rewrites history whenever a rate
  changes (#739 is the same failure for model rates).
