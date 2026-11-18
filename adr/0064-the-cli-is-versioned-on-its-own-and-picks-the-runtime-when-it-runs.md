# 0064. The CLI is versioned on its own and picks the runtime when it runs

- Status: Accepted
- Date: 2026-11-18
- Serves: run NimbleBrain on a developer's machine

## Context

`packages/cli` is the `nimblebrain` npm package: `npx nimblebrain` installs the
runtime from its release images, starts it, connects a coding agent to a
workspace, and updates or removes it. It is an installer and connector around
the runtime, not the runtime. Its features (more agents, better checks, update
handling) and the runtime's features ship on different schedules: a CLI fix must
not wait for, or force, a runtime release, and a runtime release must reach new
installs without a CLI release.

The CLI was first built in lockstep: the runtime's `v*` release published
`nimblebrain` at the same version, and that CLI installed exactly that runtime.
Lockstep is what projects do when client and engine are one product released
together: Dagger's CLI and runner share a version; Sentry self-hosted's installer
tag equals the Sentry release; Coder, Docker and Ollama number client and server
together. Projects whose CLI is a harness around a stack version it on its own:
the Supabase CLI pins each image inside the CLI; the Temporal CLI pins its dev
server in its build; wrangler pins `workerd`; Airbyte's `abctl` installs the
newest platform by default and takes `--chart-version`.

Lockstep's cost here is the coupling itself: every CLI fix becomes a runtime
release, and a runtime release also promotes prod. Pinning the runtime inside
the CLI (Supabase, Temporal) removes that but couples the other way: every
runtime release then needs a CLI release before new installs see it. Both
couplings also share one hazard: a CLI and a running runtime drift apart anyway,
so every project in either group also checks compatibility at run time
(Dagger's minimum versions, Docker's API negotiation, Coder's and Ollama's
mismatch warnings).

## Decision

The CLI has its own semver and its own release, and chooses the runtime when it
runs.

- **Its own release.** A `cli/v*` tag releases it (`.github/workflows/release-cli.yml`),
  as `server-sdk-py/v*` releases the Python SDK. The version is committed in
  `packages/cli/package.json` and the tag must match it. The runtime's `v*`
  release publishes nothing to npm. A release is staged on npm and goes public
  only when a maintainer approves it with 2FA.
- **The runtime is chosen at run time.** `--runtime <tag>`, then
  `NIMBLEBRAIN_TAG`, then the newest plain `vX.Y.Z` runtime release. So a runtime
  release reaches the next `init` or `update` with no CLI release, and a CLI
  release ships with no runtime release.
- **The Compose file comes from the chosen release's tag,** fetched before
  anything is written, never bundled, so it always matches the images it runs.
  The CLI refuses a file that does not take `NIMBLEBRAIN_TAG` and
  `NIMBLEBRAIN_WEB_PORT` from `.env`.
- **A floor keeps the two compatible.** `MIN_RUNTIME` (`packages/cli/src/release.ts`)
  is the oldest runtime the CLI drives, `v0.73.0`, the first with arm64 images
  and the port variable; anything older is `RUNTIME_UNSUPPORTED`. `update` never
  moves an install backwards.
- **Both versions are visible.** `status` reports the running runtime as
  `version` and the CLI as `cli_version`; `--version` is the CLI's.

## Consequences

- A CLI fix ships the same day without touching prod; a runtime release reaches
  `npx nimblebrain` users without a CLI release.
- Installs are not reproducible by CLI version alone: the same CLI installs a
  newer runtime next week. `--runtime` pins one when that matters (CI, a bug
  report), and `status` names what is running.
- `init` and `update` need GitHub reachable for the tag list and the Compose
  file, as they already needed GHCR for the images.
- When a runtime release changes something the CLI relies on (the Compose file's
  variables, the endpoints `status` reads), it needs a CLI release that handles
  the change, and the floor rises if older runtimes stop working. If that starts
  happening every release, the two are one product after all, and lockstep
  should be reconsidered.
- The first CLI release is `cli/v0.1.0`. npm's only earlier `nimblebrain`
  version is an unrelated `0.0.1` placeholder, to be deprecated once `0.1.0` is
  approved.
