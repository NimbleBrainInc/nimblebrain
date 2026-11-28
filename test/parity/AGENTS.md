# Parity scenarios

Scope: `test/parity/`, the scenarios that prove a runtime keeps the behaviour production has.
Each grades the items of the parity inventory (`inventory.json`) it declares, over HTTP and
MCP only, so the same scenarios run against this tree, another checkout, or a deployment.

- **Run it:** `bun run test:parity` boots this tree in-process with the directive model and
  grades it against `expected-failures.json`; `test/integration/parity-suite.test.ts` runs the
  same in CI. `PARITY_TREE=<checkout>` serves another tree (a `main` worktree, with its own
  `bun install`) from a child process (`serve.ts`). `PARITY_BASE_URL` + `PARITY_TOKEN`
  (`PARITY_TOKEN_B` for a second person, `PARITY_CAPABILITIES=org-admin`) runs against a
  deployment. `PARITY_ONLY=chat,files` picks
  scenarios by id prefix. The report is `.cache/parity/<label>.json` (`PARITY_REPORT`);
  `bun run test:parity diff a.json b.json` lists the items whose status differs.
- **Reach the runtime over the wire, never by import.** A scenario uses `client.ts` (REST,
  the event stream, the MCP door). Only `boot.ts` imports a runtime, from the tree it boots,
  and it passes the suite's model, people and catalog through `Runtime.start`'s config; those
  files import only types, so another tree can load them.
- **Steer the model with a directive.** `directive()` puts a base64url token in a message or
  a task body; `directive-model.ts` plays its steps as tool-call rounds, then replies, and
  echoes a message without one (text, then a line per file part). A call held for guidance
  is made again. A deployment's real model ignores directives, so a scenario that needs one
  declares `scripted-model` and is skipped there.
- **A deployment run writes only in workspaces it creates, and leaves none behind.** Every
  scenario writes (conversations, files, tasks, installs), and a deployment's workspaces are
  real. So against a deployment the suite creates the run's workspaces as the org admin (Alice's,
  and Bob's, which Alice then leaves) and deletes and purges them in a `finally`, failed or not;
  without `org-admin` every scenario is skipped with that reason. A scenario that creates a
  workspace calls `t.disposable(ws)` as soon as it exists, and the suite deletes and purges it
  when the scenario ends. A change to the person rather than a workspace (a preference) is put
  back in the scenario's own `finally`. A workspace the run could not purge is listed in the
  report's `leftBehind` and fails the run. In-process and tree runs use the first workspace of a
  throwaway work directory.
- **Declare what a scenario needs** (`requires`): `scripted-model`, `second-identity`,
  `org-admin`, `fixture-catalog`. A target lacking one skips the scenario, and the report says
  why for each item.
- **A check settles items.** `t.check(ids, label, fn)` passes when `fn` returns, and its
  return value is the evidence; a covered item no check reaches fails. Assert what a person or
  client observes (status, body, frames), not an internal field, and add a second check rather
  than widen one that already passes on `main`, so one difference fails one item.
- **Decided differences assert next/engine's behaviour**, with the inventory id in a comment
  beside the check; `main` fails them by design. An `unknown` item is checked for this tree's
  behaviour until it is settled. When `main` and this tree agree and the inventory says
  otherwise, the check follows the trees and says so.
- **Ids outside the inventory are `NEW-<area>-<n>`**, and `coverage.ts` describes each.
- **The baseline only shrinks.** An `expected-failures.json` entry names one check (item,
  scenario, check label), the error it fails with, and the finding with its repro. Any other
  failure on that item, or that check failing another way, is a regression. A graded run fails
  on a failure outside the baseline, on an entry that passes, and on a scenario that throws; a
  fix removes its entry in the same change. A new entry is a regression unless it is a finding the suite
  just exposed, recorded with its repro.
- **`COVERAGE.md` is generated** from `inventory.json`, the scenarios' `covers` and
  `existing-coverage.json` (item → existing test files): run `bun --no-env-file
  test/parity/coverage.ts`; `check:parity-coverage` (in `verify:static`) fails on drift.
- **Public repo:** fixtures and evidence use fictional hosts (`*.invalid`, `*.test`) and
  people; never a deployment's tenant or host.
