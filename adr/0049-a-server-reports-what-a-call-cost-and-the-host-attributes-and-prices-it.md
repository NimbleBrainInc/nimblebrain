# 0049. A server reports what a call cost; the host attributes it, prices it, and budgets it

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

What the host charges is a third number. It depends on the tenant's terms, which
the server does not know and should not encode. A price derived on read from a
table that can change rewrites history when the table changes (#739).

MCP defines no way for a server to report usage or cost, and nothing like it is
proposed upstream. The protocol leaves room for one: a result's `_meta` takes
vendor-prefixed keys, and ADR-0024 settles how ours are named and when one is
accepted from a server.

## Decision

**A server reports what a call consumed in the result's `_meta`, under
`ai.nimblebrain/usage`. The host attaches attribution, applies the tenant's
price, records both on the ledger, and debits the price from the run's spend accounts.**

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
| `id` | Server-minted, unique per server, and the same if the same work is reported again. The host ignores a report whose `id` it has already recorded from that server. A JSON-RPC id cannot serve: a client that loses a response re-issues the request under a new one. |
| `status` | `final`, or `estimated` when the server's own source says its figure is not a bill. |
| `payer` | `server` when the server paid on its own account; `caller` when it ran on credentials the caller supplied. A `caller` report is shown and never debited or priced. |
| `usage` | One or more `{meter, quantity, unit}`. `meter` is a name the server chooses for what was consumed, and never names an upstream vendor, a vendor's product, or a vendor's unit. `quantity` is a decimal string; `"0"` is a valid report of a call that consumed nothing, and is different from no report. |
| `amount` | Optional. `value` is a decimal string, `currency` an ISO 4217 code with no default. `basis` is `cost` when it is what the server paid for this call, or `price` when it is what the server charges its caller. Either way it is what this call cost the host's side. A server may withhold `amount` and report units only. |

### Credits and prepaid balances

**A credit is a unit, never a currency.** A call that draws on a prepaid balance
reports what it drew in `usage` (`{"meter": "email.validation", "quantity": "1",
"unit": "credit"}`), and reports `amount` only when it can convert credits to
money. Spending the balance and buying it are two different events:

- **Buying credits is a purchase, not a call's cost.** "$10 of credits" and
  "10,000 credits for $50" are both an acquisition: they fix a rate (dollars per
  credit) and fund a balance. They are reconciled against the vendor's invoice,
  not attributed to a run, because no run caused them.
- **A call's cost is the credits it drew, at the rate they were bought at.** The
  rate belongs to whoever bought the credits, beside the account that holds them:
  for a server on its own account, in that server's configuration, so it reports
  `amount` with `status: estimated` (a rate across purchases at different prices
  is an average, not a bill); for credits bought on the caller's account,
  `payer: caller`. A server that does not know its rate reports units only, and
  the host may price the meter by its policy.
- **A subscription with included credits** costs nothing at the margin until the
  allowance runs out, then the overage rate. The server reports the rate it
  chooses to attribute by (usually the subscription's cost over its allowance),
  as an estimate. The subscription itself, like any charge with no originating
  call, is not a ledger line.

Because every line keeps its units, a rate found to be wrong can be corrected by
re-pricing lines on purpose. It never happens as a side effect of reading.

The same rule holds on the host's side of the price. If a tenant buys
NimbleBrain credits rather than paying in dollars, the price policy prices in
that unit, and a spend account is denominated in it. The tenant's purchase of
credits is billing, not a ledger line.

A report describes its own hop. A server that called other servers reports what
this call cost its caller, never the reports it received.

The host asks for reports by sending `_meta: {"ai.nimblebrain/usage": {}}` on each
`tools/call`, because the connections the host speaks on do not all carry
negotiated extensions. A server sends a report only to a request that asked: a
client that did not may put `_meta` where a model reads it.

### What the host does with it

- **It is accepted from the wire, and bounded.** By ADR-0024's test, accepting
  it widens nothing: a server that over-reports makes its own tenant's budget
  stricter and its own cost higher, both through a server the workspace chose to
  connect; one that under-reports or claims `payer: caller` is no worse than
  reporting nothing. The host validates the report whole (entry count, string
  lengths, decimal grammar, currency) and drops a malformed one entirely. Every
  string in it is the server's, displayed as text, never interpreted.
- **It never reaches a model.** The model's view of a result is built from
  `content`, and the report is read only by the host. The host's own MCP
  endpoint does not forward a server's `_meta` to the client that called it.
- **It becomes a ledger line.** A line of kind `tool`, beside the model call's
  kind `llm`, carrying the server and tool names, the report as received, the
  receipt time, and the same attribution a model call's line carries.
- **No report is unknown, not zero.** The host records nothing for a call
  without one, and shows, per server, whether it reports at all.

### Attribution: a run carries labels

**A run's description may name labels, a small bounded map of opaque string
keys and values that the source starting the run chooses. The kernel stamps them
on every ledger line the run produces, model and tool alike, and never
interprets them.** This is the shape spend accounts already have: the source
names ids, and the door never reads their meaning.

The source that knows what a run is about sets them. A task names its task and
its batch, and a task definition may map fields of its input to labels, so every
run over one customer record carries the same value and the cost of that record
is one filtered sum over the ledger, across any number of runs and tasks. A
conversation names none. Totals are computed on read by filtering and grouping
on labels; nothing is rolled up in advance.

A call made on a run's behalf after it ends, such as the assessment of its
deliverable, carries that run's labels.

### Price: the host's policy, stored at write

**What a tenant pays is the host's decision, made by a price policy in tenant
configuration and applied when the line is written.** The policy prices a line
from its cost, with a markup by default and an optional rate per meter, and
covers model lines and tool lines alike. Each line stores its `cost`, its
`price`, and the version of the policy applied, as model lines already store the
rates they were priced at. Changing the policy changes lines written after the
change and none before.

Tenant views show price. Cost and margin are for the operator. A server's
`basis: price` is the host's cost: the host records it as cost and prices it
again.

### Budgets

**A spend account in the unit the price policy prices in (`usd`, or a credit
unit the host sells) is debited a tool line's price after the call, and a tool
call is refused while any such account its run holds is at or below zero.**
Nothing is reserved before a tool call, because nothing about its cost is known
before it. A run can therefore pass its budget by the cost of one tool call,
as it can already pass it by input beyond its projection. A line with no amount
debits nothing, so a budget is only as complete as the reports behind it, and a
run or batch shows how many of its tool calls had no price.

Token-unit accounts are never debited by a tool line. They budget the run's own
model.

### Not decided here

A charge that settles after the call (a pending report and a way to fetch its
final figure), a charge with no originating call, corrections, a price declared
before a call, and a host-side estimate for servers that report nothing are each
their own decision, taken when a server needs one. The identifier is ours; it
changes only if a shared shape is standardized, which needs other
implementations first.

## Consequences

- A run's cost, a batch's cost, and a budget mean all spend that was reported,
  not model spend alone, and a tenant can see which servers report nothing.
- Cost per business object needs no kernel concept of the object. Whether it
  adds up depends on authors labelling consistently: two tasks that name the same
  record under different keys produce two costs that never meet. The task
  authoring guide has to say so.
- The ledger grows by one line per reported tool call. It stays a display
  surface, not a billing record: an invoice, when there is one, freezes its own
  prices, and the stored policy version is what makes it reproducible.
- Every report is the server's claim. Over-reporting by a server the tenant
  connected is answered by disconnecting it; nothing in this design proves a
  figure.
- A third-party server can report without reading our source, and a server that
  reports nothing is unaffected.
- A tool's spend reaches a budget one call late, so a single expensive call can
  overshoot it.

## Alternatives considered

- **A host-side price table per tool.** Wrong for any cost that varies with
  arguments or outcome, which is the case that matters.
- **Server telemetry joined on trace id.** Works only when the host operator also
  runs the server's collector, and still needs a join to reach the attribution
  the host held at the moment of the call.
- **The server reports the tenant's price.** Puts each tenant's terms into every
  server, and cannot price a server we do not operate.
- **Attribution as ledger fields (`batchId`, `subject`, ...).** Each grouping a
  kernel field, each a concept the kernel should not know.
- **Reserving a tool call's cost before it.** Nothing about it is known before it;
  a reservation would be a guess dressed as a guarantee.
- **Price derived on read.** Rewrites history whenever the policy changes.
