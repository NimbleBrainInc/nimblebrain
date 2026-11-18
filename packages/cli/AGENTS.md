# packages/cli: the `nimblebrain` CLI

> Read by agents. Terse, imperative. Scope and contract: issue #2028.

Published to npm as `nimblebrain`; run as `npx nimblebrain`. It installs, starts, updates and removes a local NimbleBrain from the release images, and connects a coding agent to a workspace. Not to be confused with `src/cli/`, the server's own entry point inside the container.

## Rules

- **Setup and running only.** Commands cover checking the machine, installing, starting, stopping, logs, the model key, updating and removing. Anything inside a running instance (apps, connectors, tasks, chat) belongs to the web UI and `/mcp/<workspaceId>`; never add a subcommand for it.
- **Node 20+, no Bun at run time, no dependencies.** `npx` must start fast on a clean machine. Use `node:` built-ins only; `bun build --target=node` bundles to one file. Bun is the dev and test toolchain, as everywhere in this repo. `import.meta.main` is Node 24+, so the entry point is `src/bin.ts`, not a guard.
- **Every run answers exactly once.** `bin.ts` writes the answer synchronously; an `exit` hook (and SIGINT/SIGTERM/SIGHUP, routed through `process.exit`) writes `INTERRUPTED` with the exit code if the process ends first. Never write the answer any other way, or end the process before it is written.
- **Every command answers the same shape.** `{ok: true, ...}` or a thrown `CliError`, which `main.ts` turns into `{ok: false, error, message, fix}`. Exit 0 / 1 / 2 (usage). An error code is a published contract once released: add codes freely, never rename one. Each code's `fix` lives once, in `ERRORS` in `src/result.ts`.
- **The model key never appears in arguments, output or logs.** Only `key` takes it, at a hidden prompt, and writes it to `<home>/.env` with mode 600. `status` reports `model_key: set | missing` from the install's `.env` (names only), never from the runtime: bootstrap's `configuredProviders` lists the providers the config allows, key or no key.
- **The web port is published on `127.0.0.1` only.** The local instance uses the `dev` adapter, which signs nobody in.
- **Never touch an install the CLI did not make.** The Compose project name in `install.json` marks containers and the data volume as ours; anything else is `NOT_OURS`.
- **The CLI is versioned on its own; the runtime is chosen when it runs** (ADR-0064). `--runtime`, then `NIMBLEBRAIN_TAG`, then the newest plain `vX.Y.Z` release; anything below `MIN_RUNTIME` (`src/release.ts`) is `RUNTIME_UNSUPPORTED`. Never tie a CLI version to a runtime version.
- **The Compose file is the chosen release's own,** fetched from its tag (`fetchCompose`) before anything is written. Never write a second Compose file here. Model-key variable names and `key`'s provider list are read from the installed file, not restated. A Compose file that does not take `NIMBLEBRAIN_TAG` and `NIMBLEBRAIN_WEB_PORT` from `.env` is refused.
- **Compose runs without the shell's keys, `NIMBLEBRAIN_TAG`, `NIMBLEBRAIN_WEB_PORT` or `COMPOSE_PROJECT_NAME`** (`composeEnv`), so `<home>/.env` is the one source: a key exported in the shell would otherwise silently win over the one entered with `key`.
- **`up -d --no-build`, always.** The root Compose file keeps `build:` for source checkouts; the install folder has no source, so a missing image must fail as a pull, never fall back to a build.
- **Connecting an agent and installing the skill never fail `init`.** The instance is usable either way; a failed connection returns `manual`, the exact settings to add by hand.
- **Telemetry waits for a person's answer (`src/telemetry.ts`).** `init` takes it from `--telemetry`, else asks a person at the terminal once they have agreed to start (only a typed yes is yes; a failure before that waits like `undecided`), else leaves it `undecided` and returns the question in `telemetry.ask` for an agent to pass on. Never default it on, and never let `--yes` answer it. Until a yes, events wait in `telemetry-report.jsonl` (mode 600); a yes sends them, a no deletes them. Once the runtime runs, it owns the answer (`nb__set_telemetry`, the same tool the web UI uses); the CLI holds it in `.env` (`NB_TELEMETRY_CONSENT`) only for the runtime's first start. No key or `DO_NOT_TRACK=1`: ask no one, write nothing, send nothing. Only the release build (`build:release`, run by `release-cli.yml`) has a destination, so a development or CI build never sends; the version cannot tell them apart, since it is committed. The runtime gets the key only when its Compose file passes `NB_TELEMETRY_CONSENT` through (`asksConsent`), because an older runtime sends by default once it has a key. Telemetry never fails a command. `TELEMETRY_KEY` is the "NimbleBrain Self-hosted" project's write-only key, public by design; never point it at a project that holds customer data.
- **All I/O goes through `Deps` (`src/deps.ts`).** Tests pass a fake and stay unit tests: no Docker, no ports, no network.

## Not here yet

- **A skill matched to the release.** `installSkill` takes the `nimblebrain` skill from the skills repo's default branch; that repo has no release tags to pin to yet.

## Releasing

Its own `cli/v*` tags and `.github/workflows/release-cli.yml` (RELEASING.md, "Releasing the CLI"), like `packages/server-sdk-py`. The version lives in this `package.json`; bump it in the PR that ships the change, and the tag must match it. A release is staged on npm and goes public only when a maintainer approves it with 2FA. `cli-e2e` runs the whole lifecycle on `ubuntu-latest` and `ubuntu-24.04-arm` against the newest runtime release.

## Verify

- `bun run test:cli`: unit tests (in `verify:test-unit`).
- `bun run check:cli`: type-check, build, and run the built file under Node (in `verify:static`).
- `node packages/cli/dist/nimblebrain.js doctor` after a build tries it against this machine.

## The skill side

The `nimblebrain` skill in `NimbleBrainInc/skills` drives this CLI and documents its commands, fields and error codes in `skills/nimblebrain/references/cli.md`. Change both together.
