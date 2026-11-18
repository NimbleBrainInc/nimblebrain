# packages/cli: the `nimblebrain` CLI

> Read by agents. Terse, imperative. Scope and contract: issue #2028.

Published to npm as `nimblebrain`; run as `npx nimblebrain`. It installs, starts, updates and removes a local NimbleBrain from the release images, and connects a coding agent to a workspace. Not to be confused with `src/cli/`, the server's own entry point inside the container.

## Rules

- **Setup and running only.** Commands cover checking the machine, installing, starting, stopping, logs, the model key, updating and removing. Anything inside a running instance (apps, connectors, tasks, chat) belongs to the web UI and `/mcp/<workspaceId>`; never add a subcommand for it.
- **Node 20+, no Bun at run time, no dependencies.** `npx` must start fast on a clean machine. Use `node:` built-ins only; `bun build --target=node` bundles to one file. Bun is the dev and test toolchain, as everywhere in this repo. `import.meta.main` is Node 24+, so the entry point is `src/bin.ts`, not a guard.
- **Every command answers the same shape.** `{ok: true, ...}` or a thrown `CliError`, which `main.ts` turns into `{ok: false, error, message, fix}`. Exit 0 / 1 / 2 (usage). An error code is a published contract once released: add codes freely, never rename one. Each code's `fix` lives once, in `ERRORS` in `src/result.ts`.
- **The model key never appears in arguments, output or logs.** Only `key` takes it, at a hidden prompt, and writes it to `<home>/.env` with mode 600. `status` reports `model_key: set | missing` from the install's `.env` (names only), never from the runtime: bootstrap's `configuredProviders` lists the providers the config allows, key or no key.
- **The web port is published on `127.0.0.1` only.** The local instance uses the `dev` adapter, which signs nobody in.
- **Never touch an install the CLI did not make.** The Compose project name in `install.json` marks containers and the data volume as ours; anything else is `NOT_OURS`.
- **The Compose file is the release's own, embedded at build** (`import … with { type: "text" }` of the root `docker-compose.yml`). Never write a second Compose file here; a change to how the runtime is composed lands in the root file, and the CLI ships it. Model-key variable names and `key`'s provider list are read from that file, not restated.
- **Compose runs without the shell's keys, `NIMBLEBRAIN_TAG`, `NIMBLEBRAIN_WEB_PORT` or `COMPOSE_PROJECT_NAME`** (`composeEnv`), so `<home>/.env` is the one source: a key exported in the shell would otherwise silently win over the one entered with `key`.
- **`up -d --no-build`, always.** The root Compose file keeps `build:` for source checkouts; the install folder has no source, so a missing image must fail as a pull, never fall back to a build.
- **Connecting an agent and installing the skill never fail `init`.** The instance is usable either way; a failed connection returns `manual`, the exact settings to add by hand.
- **Telemetry waits for a person's answer (`src/telemetry.ts`).** `init` takes it from `--telemetry`, else asks a person at the terminal (only a typed yes is yes), else leaves it `undecided` and returns the question in `telemetry.ask` for an agent to pass on. Never default it on, and never let `--yes` answer it. Until a yes, events wait in `telemetry-report.jsonl` (mode 600); a yes sends them, a no deletes them. Once the runtime runs, it owns the answer (`nb__set_telemetry`, the same tool the web UI uses); the CLI holds it in `.env` (`NB_TELEMETRY_CONSENT`) only for the runtime's first start. No key or `DO_NOT_TRACK=1`: ask no one, write nothing, send nothing. Telemetry never fails a command. `TELEMETRY_KEY` is the "NimbleBrain Self-hosted" project's write-only key, public by design; never point it at a project that holds customer data.
- **All I/O goes through `Deps` (`src/deps.ts`).** Tests pass a fake and stay unit tests: no Docker, no ports, no network.
- **Each CLI release installs the runtime release of the same version.** The version is set from the release tag, like the root package; do not bump `package.json` by hand.

## Not here yet

- **A skill matched to the release.** `installSkill` takes the `nimblebrain` skill from the skills repo's default branch; that repo has no release tags to pin to yet.

## Releasing

`release.yml` job `publish-cli` publishes this package at every `v*` tag's version, after the images are on GHCR (RELEASING.md §7, job 5): GA to `latest`, a pre-release to `next`, a hotfix tag to nowhere. The version is set from the tag in the job; `package.json` stays `0.0.0-dev`. `cli-e2e` runs the whole lifecycle on `ubuntu-latest` and `ubuntu-24.04-arm` against the newest release.

## Verify

- `bun run test:cli`: unit tests (in `verify:test-unit`).
- `bun run check:cli`: type-check, build, and run the built file under Node (in `verify:static`).
- `node packages/cli/dist/nimblebrain.js doctor` after a build tries it against this machine.

## The skill side

The `nimblebrain` skill in `NimbleBrainInc/skills` drives this CLI and documents its commands, fields and error codes in `skills/nimblebrain/references/cli.md`. Change both together.
