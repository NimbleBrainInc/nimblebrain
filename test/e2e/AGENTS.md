# End-to-end tests

Scope: `test/e2e/`, the scenarios that drive the whole system the way a person or an MCP
client does. A scenario is one user journey (sign in, send a message, upload and download a
file, run a scheduled task, install a plugin) carried out only through the public interfaces:
REST, the conversation event stream, and the MCP door (a browser later). Because nothing
reaches past those interfaces, the same scenarios run against this tree in CI and against a
deployment after it deploys.

## Running

- **In-process (CI):** `bun run test:e2e` boots this tree (`boot.ts`) with the directive
  model, two token-signed people (`identities.ts`: Alice an org admin, Bob a member) and the
  fixture catalog, then runs every scenario. `test/integration/e2e-suite.test.ts` runs the
  same inside `test:integration`, and fails on any scenario that does not pass, a skip included.
- **Smoke:** `bun run test:e2e --smoke` runs only the scenarios tagged `smoke`.
- **A deployment:** `E2E_BASE_URL=<url> E2E_TOKEN=<alice> E2E_CAPABILITIES=org-admin bun run
  test:e2e --smoke` after a deploy; drop `--smoke` for every scenario the deployment can serve.
  `E2E_TOKEN_B` adds the second person (`second-identity`); `E2E_CATALOG_BASE` names the
  fixture catalog's artifact server where one is configured.
- `--only chat,files` (or `E2E_ONLY`) picks scenarios by id prefix; a prefix that selects
  nothing is refused, naming it, since a mistyped filter would otherwise test nothing. The
  report is `.cache/e2e/<label>.json` (`E2E_REPORT`, `E2E_LABEL`).
- **The exit code is the verdict.** It is non-zero when a check fails, a scenario throws or
  runs no check, the run leaves something behind, or no scenario passes (nothing selected,
  or every one skipped): a run that passed nothing proves nothing. A failing e2e test
  fails; a known bug is an issue, never an exception the suite carries.
- **`catalogs.browse` asserts only what holds on every deployment:** Browse answers, and
  each row it lists has a name and an address. A deployment may configure no catalog, so an
  empty listing passes unless the operator states one is expected with
  `E2E_EXPECT_CATALOG=1`; in-process it is always expected (the fixture catalog).

## Rules

- **Reach the runtime over the wire, never by import.** A scenario uses `client.ts` (REST,
  the event stream, the MCP door) and type imports only. Only `boot.ts` imports the runtime,
  so a scenario cannot depend on anything a deployment does not expose.
- **Assert what a person or client observes** (status, body, frames, bytes, headers), not an
  internal field. One `t.check(label, fn)` per observable fact: `fn` throws on a wrong
  result and returns its evidence, so a failure names one fact and shows what was seen.
- **Steer the model with a directive.** `directive()` puts a base64url token in a message or
  a task body; `directive-model.ts` plays its steps as tool-call rounds, then replies, and
  echoes a message without one (text, then a line per file part). A deployment's real model
  ignores directives, so a scenario that needs one declares `scripted-model` and is skipped there.
- **Declare what a scenario needs** (`requires`): `scripted-model`, `second-identity`,
  `org-admin`, `fixture-catalog`. A target lacking one skips the scenario with the reason.

## Cleanup on a deployment

A deployment's workspaces are real and every scenario writes, so:

- **The suite writes only in workspaces it creates.** It creates the run's workspaces as the
  org admin (Alice's, and Bob's when a selected scenario needs him, which Alice then leaves)
  and deletes and purges them in a `finally`, failed or not. Without `org-admin` every
  scenario is skipped with that reason, and the run fails.
- **A scenario that creates a workspace calls `t.disposable(ws)` as soon as it exists**; the
  suite deletes and purges it when the scenario ends.
- **A change to the person rather than a workspace** (a preference) is made inside the
  scenario's `try` and put back in its `finally`, and the restore is proven by reading the
  value back. A restore that fails or does not read back goes to `t.leftBehind(why)`, which
  lists it in the report's `leftBehind` beside workspaces, failing the run. No public
  interface unsets a timezone, so `tasks.authoring` can restore only a set one; the
  in-process people are provisioned with `UTC`.
- **A workspace is gone only when its purge succeeds, or successful listings (live and
  deleted) lack it.** Any other answer lists it in the report's `leftBehind`, which fails the run.
- In-process runs use each person's first workspace of a throwaway work directory.

## Adding a scenario

- Put it in `scenarios/<capability>.ts`, id `<capability>.<journey>` (`chat.reply`,
  `files.download`), and list it in `scenarios/index.ts`.
- Make it pass in-process before it lands: CI runs every scenario and allows no skip.
- **Tag it `smoke` only when it is fast (seconds), safe on a deployment, needs no capability
  beyond `org-admin`, and covers a critical journey** whose break means the deploy is bad.
  Smoke runs with the deployment's real model, so assert the shape of a reply, never its
  words. Keep the group small; depth belongs in the other scenarios.
- **Public repo:** fixtures and evidence use fictional hosts (`*.invalid`, `*.test`) and
  people; never a deployment's tenant or host.
