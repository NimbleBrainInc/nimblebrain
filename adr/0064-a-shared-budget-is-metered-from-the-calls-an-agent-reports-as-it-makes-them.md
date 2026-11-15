# 0064. A shared budget is metered from the calls an agent reports as it makes them

- Status: Proposed
- Date: 2026-11-15
- Serves: orchestrate remote MCP
- Amends: [ADR-0063](./0063-a-runs-model-credential-carries-the-spend-it-is-allowed.md) (how a run on an external runtime is held to a spend account)

## Context

ADR-0063 holds a run on an external runtime to a spend account by its model
credential: the door reserves the run's share of the account, the balance divided
by the runs that may draw on it at once, and the gateway refuses the run's calls
once it has spent that share. One mechanism does two jobs there: it keeps a
shared budget's books, and it stops a run the runtime cannot see inside.

The gateway is the wrong place to keep the books, for three reasons that follow
from what it is.

- **It counts tokens, and a budget is in dollars.** The gateway counts input and
  output tokens together. A model's rates differ by token kind by two orders of
  magnitude: a cached input token against an output token on the dearest card.
  No one rate converts dollars to tokens well, so the door converts at the
  dearest, and a run that mostly re-reads a cached prompt is refused after
  spending a small fraction of the dollars its share stood for.
- **It approximates downward.** The count is held per gateway replica, so a grant
  is divided by the replica count and rounded down to one of a fixed set of
  limits.
- **A share is a prediction.** Dividing what is left by the runs at once guesses
  that every run costs the same. A run that needs more than its share stops with
  the account's balance unspent, and since the balance only falls, running it
  again at the same share stops it at the same place. The batch driver answers
  by halving how many runs share the budget, which trades the budget's stall for
  the batch's speed.

ADR-0063 chose the share on evidence that a share is many times an item's cost.
That holds in dollars. Enforcement is in tokens at the dearest rate, which gives
most of that margin back.

The runtime keeps the account's ledger in dollars and debits it with the usage an
agent reports, priced at each call's own rates. That is the place to keep the
books. What it lacks is the usage in time: an agent reports every call of a turn
with the turn's response, so the runtime learns what a run spent only once the
run has ended.

## Decision

A shared budget is metered where its ledger is, from each model call as the
agent reports it, and a run is stopped when the account is spent. The gateway's
limit is a ceiling on one run, not the run's share of the budget.

- **An agent that can reports each model call as it completes.** The report
  carries what the turn's response carries for that call: the model and its
  usage. A driver states whether its agent reports this way. The response still
  carries the turn's whole usage, and the runtime counts each call once.
- **The door debits a reported call when it arrives.** Every run naming the
  account draws on the one live balance, as on the native engine.
- **The door ends every run holding an account whose balance is spent.** The run
  stops with `spend_limit` naming the account, by the cancel the runtime already
  sends an agent. A source reads the stop as it reads the native engine's.
- **Such a run reserves nothing of the account, and its grant is a ceiling.** The
  grant is the least of the run's own cap, the gateway's ceiling for any run, and
  what the account's whole balance buys at the model's dearest rate. It bounds an
  agent that stops reporting; it is not what the run is expected to spend.
- **An agent that reports only with its response is held as ADR-0063 has it.**
  Its run reserves a share and is granted that share. Nothing changes for it.

The native engine keeps its per-call check and its exact clamp.

## Consequences

- A budget can be spent to its last call. A run stops because the money is gone,
  not because a prediction of its cost was low, so a source no longer needs to
  shrink how many runs it starts to make a share large enough.
- The account can be passed by the calls in flight when it is spent, one per run
  that holds it, plus any call an agent starts before it heeds the cancel. That
  is the overshoot ADR-0063 already accepts for one run, summed over the runs
  sharing the account. The native engine's bound is tighter and stays so.
- An agent that under-reports is bounded by its grant, and the grant is now a
  ceiling, so it can misstate a shared account by more than a share before the
  gateway stops it. The door trusts an agent's reports for metering as it already
  does for settlement; the ceiling is what that trust is limited to.
- The usage ledger receives a call when it is made, so a run cut off mid-turn has
  its finished calls recorded whether or not the agent answers the cancel.
- The gateway needs no change and keeps no dependency on the runtime.
- Reporting per call is one more thing a driver may ask of its agent beyond ACP.
  An agent that does not do it loses nothing it has today.

## Alternatives considered

- **Price a share at the rates a run is expected to pay.** Still a prediction: it
  is wrong for the next task whose mix of cached input and output differs, and a
  low guess stops runs with the budget unspent as today.
- **Have the gateway count dollars.** It counts tokens of every kind alike, and
  pricing belongs to the runtime, which holds the rate cards and the ledger.
- **Have the gateway ask the runtime's ledger on each call.** Rejected by
  ADR-0063: it makes the gateway depend on the runtime and adds a round trip to
  every call.
- **Start a run only when the account can pay an estimate of it.** Admission by
  estimate keeps runs from starting what they cannot finish, but it needs a cost
  per run that the source must learn or be told, and it still cannot stop a run
  that costs more than the estimate.

## To measure before acceptance

- The delay from a model call ending in the agent to its debit at the door.
- The delay from the door's cancel to the agent's last model call starting.
- The overshoot of a budget spent by a batch at its usual concurrency, against
  the bound above.
