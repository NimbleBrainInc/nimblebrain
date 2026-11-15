# 0064. A run's grant is money, and the gateway charges each call what it cost

- Status: Proposed
- Date: 2026-11-15
- Serves: orchestrate remote MCP
- Amends: [ADR-0063](./0063-a-runs-model-credential-carries-the-spend-it-is-allowed.md) (the unit of a grant, and how the gateway counts against it)

## Context

ADR-0063 puts a run's limit in its model credential: the door reserves the run's
share of each spend account, and the gateway refuses the run's calls once it has
spent that share. The credential is the run's capability to spend, and a
capability carries its own limit, so whoever enforces it needs nothing else. The
gateway is the right enforcer: every model call of every agent passes through
it, whatever the agent is and whatever it reports.

The grant is a number of tokens, input and output counted alike, because that is
what the gateway counted. A spend account is money. A model's rates differ by
token kind by two orders of magnitude, a cached input token against an output
token on the dearest card, so no one rate converts money to tokens well. The
door converts at the dearest rate so that a grant can never buy more than its
share. A run that mostly re-reads a cached prompt is then refused after spending
a small fraction of the money its share stood for: it stops with the account's
balance unspent, and running it again at the same share stops it at the same
place.

ADR-0063 chose a share of the balance on evidence that a share is many times an
item's cost. That holds in money. Counting in tokens at the dearest rate gives
most of that margin back, and a count kept apart in each gateway replica, with
the grant divided among them and rounded down, gives back more.

The fault is the unit, not the place. A gateway that charges a call by the kind
of each token, against one count per run, holds a run to its share in the unit
the account is kept in.

## Decision

A grant is an amount of money, and the gateway charges each call what it cost at
rates the credential carries.

- **The grant is in the account's money.** For a `usd` account the door grants
  the run's share as it is, with no conversion to tokens. A token account and a
  run's own input-token cap are granted in tokens, as ADR-0063 has them.
- **The credential carries the run's rates beside its grant.** One rate for each
  kind of token the run's model bills: input, cached input, cache writes, and
  output. They are the runtime's own rate card for that model, so the runtime
  prices a call at the gateway exactly as it prices it in its ledger, and the
  gateway keeps no prices of its own. Where a model's card has tiers, each kind
  carries its dearest tier's rate, so a grant errs toward stopping early by the
  ratio between tiers and never by the ratio between kinds.
- **The gateway charges a call when it completes**, its reported tokens of each
  kind at the credential's rates, and refuses the run's next call once its
  charges reach the grant. It admits a call while the run is below its grant,
  as ADR-0063 has it.
- **A run has one count, whichever replica serves its call.** The grant is not
  divided among replicas.
- **A call the gateway cannot hold to a grant is held to the gateway's own
  ceiling for a run, never to nothing.** That covers a credential with no grant
  or no rates, and a call whose usage the gateway cannot read.
- **The gateway says what it enforces.** Its answer names the unit of the grants
  it enforces. A gateway that counts tokens alike is given a grant in tokens at
  the dearest rate, as ADR-0063 has it; one that enforces nothing leaves
  budgeted runs on the native engine.

The door still reserves a run's share of each account when it mints the
credential, and settles from the usage the agent reports. The native engine
keeps its per-call check.

## Consequences

- A share is what ADR-0063 measured it to be: many times an item's cost. A run
  stops because it spent its share of the money, so a source seldom needs to
  shrink how many runs share a budget to make a share large enough.
- Any agent is held the same way. Nothing is asked of an agent beyond its model
  calls going through the gateway.
- The gateway's count must be shared by its replicas, so it lives outside them.
  That store is in the path of every model call. When it cannot be reached the
  gateway refuses calls rather than admit them uncounted, so its outage stops
  budgeted work and never overspends an account.
- A grant is still an admission threshold: a run can pass it by its last call.
  ADR-0063's bound is unchanged.
- The gateway and the ledger can disagree by what the gateway cannot see, such
  as a rate the runtime changes during a run. The ledger settles the account;
  the gateway only stops the run.
- A credential is larger by its rates, and a model added to the runtime's rate
  cards needs no change at the gateway.

## Alternatives considered

- **Meter a shared budget at the door from each call an agent reports as it
  makes it, with the gateway's limit a loose ceiling.** It moves enforcement from
  the gateway to the party being limited, holds only an agent that reports per
  call, and lets an agent that under-reports pass a budget by a ceiling's worth
  per run.
- **Have the gateway price calls from its own catalog.** Two price lists for one
  ledger, which disagree whenever one is updated first.
- **Convert a share to tokens at a rate nearer what runs pay.** Still one rate
  for kinds that differ a hundredfold: wrong for the next task with a different
  mix, and able to buy more than its share when the mix is dearer than guessed.
- **Have the gateway ask the runtime's ledger on each call.** Rejected by
  ADR-0063.

## Evidence

Measured on the gateway release the platform runs, with two replicas and a
shared count:

- A limit can be read from the request, and a call charged an amount computed
  from its tokens of each kind once it completes. A call of mostly cached input
  was charged its weighted cost exactly.
- Calls alternating between the replicas drew on one count, and the run was
  refused on the first call after its charges passed the limit.
- Runs with different ids kept separate counts.
- A request whose limit could not be read was admitted with no limit, and with
  the shared count unreachable the gateway refused every call. The first is why
  the decision names a ceiling; the second is the outage described above.

To measure before acceptance:

- The same with the limit and rates read from a signed credential's claims.
- A streamed response, whose usage arrives at its end.
- Each provider's usage shape, since providers differ on whether reported input
  includes cached tokens.
- The ceiling for a call that cannot be held to a grant.
- How the gateway's refusal reads to the runtime, which tells a spent grant from
  a provider's rate limit by the response.
