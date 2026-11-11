# 0060. An ended run's data expires after a retention window

- Status: Accepted
- Date: 2026-11-11
- Serves: orchestrate remote MCP
- Amends: [ADR-0045](./0045-a-task-is-the-unattended-primitive-and-its-trigger-is-optional.md) (how long run history, a run's handle, and a one-off task are kept)

## Context

ADR-0045 keeps run history indefinitely and names the cost: storage grows with
use. The partitioned, paged index keeps every read bounded, and nothing bounds
the disk. Each run leaves a record, a deliverable, and, when it was asked for by
id, a ticket; each inline run leaves a one-off task as well. A deployment whose
agents call `tasks__run` in a loop writes these as fast as its run slots turn
over, on the one data volume every workspace of the instance shares, so a
single busy owner can fill it and stop the instance for everyone.

A run's data lives on the runtime's own disk, behind paths only the tasks app
constructs. No connector and no operator tool can reach it without the layout
becoming a contract, so bounding it is the runtime's job, and the job of the
app that owns the storage.

Deleting history is the one thing here that cannot be undone, so the rule has
to be simple enough to state in a sentence and conservative about anything
still in use.

## Decision

**What an ended run leaves on disk is deleted once it is older than one
retention window, `tasks.runRetentionDays`.** One number, because the three
stores it bounds grow by the same event (a run ending) and an operator reasons
about one question: how long a finished run stays.

- **Archived runs expire a month at a time.** The archive is partitioned by the
  month a run started, so a month whose end is older than the window is removed
  as a directory, records and deliverables together. Every run is kept at least
  the window; the newest runs of a task (the hot window) are never deleted,
  whatever their age.
- **A run's handle expires with the window.** The ticket that finds a requested
  run by id alone, and the idempotency key that names it, are deleted once the
  run ended longer ago than the window. Over the wire the handle's `ttl` is the
  window, so a client is told how long it may poll. A repeat of a key after
  that asks for a new run.
- **A one-off task expires with its run.** A one-off whose definition and newest
  run are older than the window is deleted, definition and runs together.

**The window has a finite default.** A default that keeps everything leaves
every deployment one busy owner away from a full volume, and an operator finds
out when the instance stops. The default is several times the longest period
the tasks app's own reports read by default. An operator who must keep
everything sets the window to the top of its range; there is no separate
"forever" value to special-case.

**The sweep never deletes what is still in use:** a run that is queued or
running, anything in a task's hot window, a ticket or an archive an unsettled
batch may still read, a one-off any batch record names, or a one-off with a run
in flight.

**The runtime runs the sweep itself**, at start and daily, in the tasks app.
There is no tool that performs it and none that must be called: an invariant
the runtime depends on to stay up is not left to a caller.

**A removal is whole to every reader.** A directory is renamed out of use
before its files are unlinked, and each multi-part removal is ordered so that
what a crash leaves is still expired and is removed by the next sweep.

## Consequences

- Disk use for run data is bounded by the run rate times the window, and an
  operator has one knob to trade history for space.
- History is no longer complete. A run past the window and outside its task's
  hot window is gone: its record, its deliverable, and its verdict as a labeled
  example. Reports that reach further back than the window undercount.
- An upgrade onto this rule deletes history older than the default window on
  its first sweep. An operator who wants it kept sets the window first.
- An idempotency key is honored for the window, not forever. A caller that
  repeats a key after it gets a second run.
- A low-volume task keeps runs far older than the window, because its hot
  window is a count, not a time. The window is a floor on how long a run is
  kept, never a promise that it is deleted.
- A batch's results are read through its task's runs, so a settled batch older
  than the window lists its items without their deliverables. Batch records
  themselves, and the run history of a deleted saved task inside its hot
  window, are small per entry and are not expired by this rule.
- Splitting the window per store later is an additive config change; merging
  three knobs into one would not have been.

## Alternatives considered

- **Keep everything unless configured.** Reversible on upgrade, and leaves the
  failure in place for every deployment that does not read the config reference.
- **One knob per store** (archive months, ticket days, one-off days). Three
  interfaces for one question, with no deployment yet needing them to differ.
- **A cap on bytes or on runs per task.** Needs accounting the store does not
  keep, and deletes by volume what a person expects to keep by age.
- **A `tasks__purge` tool, or a script an operator runs.** A bound someone must
  remember to apply is not a bound.
- **Rewriting index files to drop expired lines.** The month partition already
  makes expiry a directory removal; a rewrite reopens the crash window the
  partition closed.
