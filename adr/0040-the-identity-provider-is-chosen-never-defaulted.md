# 0040. The identity provider is chosen, never defaulted

- Status: Accepted
- Date: 2026-09-27
- Serves: secure RBAC

## Context

`instance.json` names the identity provider that authenticates every request.
Local development and end-to-end testing want no login, and the `dev` provider
serves them: every request is one local developer, `usr_default`, an org owner.

If a missing `instance.json` meant `dev`, then a deployment that omits the file
by mistake, a volume that fails to mount, or a config template that leaves it
out would serve every caller as that owner, on whatever address it listens on.
Nothing would fail; the only sign would be a log line. Missing configuration
would decide authentication, and it would decide it in the direction that
admits everyone.

## Decision

- **The identity provider is chosen by name in `instance.json`.** The adapters
  are `dev`, `oidc` and `workos`, validated and constructed the same way.
  `{"auth":{"adapter":"dev"}}` is the whole dev config.
- **No provider, no runtime.** `Runtime.start` builds the provider
  `instance.json` names, or takes one an in-process caller passes (a test). With
  neither it refuses to start, and `serve` exits saying what to write for dev
  and for a real provider. There is no state in which the runtime runs without
  a provider.
- **The runtime is the one owner of the provider.** The server authenticates
  with the runtime's provider and has none of its own, so the identity a
  request carries is the identity the runtime's permission checks judge.
- **Every run names its caller and its workspace.** A chat, turn or task with
  no identity, or naming no workspace, is refused under every provider. The
  runtime never falls back to the dev user or chooses a workspace; an
  in-process caller passes both, as the HTTP doors and the scheduler do.
- **The dev launchers make the dev choice, on disk.** `bun run dev` and its
  variants write the `dev` adapter into a workdir that has no `instance.json`,
  and leave an existing one alone. The choice is made by the tool the developer
  ran, and it is visible in the workdir.
- **No request is admitted as dev because something is absent.** Not a null
  provider, a missing file, or an unset variable.

## Consequences

- A deployment that omits `instance.json` fails at start instead of serving.
  Upgrading one that ran without the file means writing one: `dev` to keep the
  single local user, or a real adapter.
- The Docker Compose file mounts `./instance.json` into the workdir and fails if
  it is absent; the quickstart writes the `dev` adapter first.
- Under `dev`, the runtime's own authorization checks see a real provider and a
  real identity, so the dev user passes them as an org owner and an admin of its
  workspaces, not by skipping them. CORS, secure cookies and request rate limits
  are the same under `dev` as under any provider.
- No permission check in the runtime has a branch for a missing provider. A
  future entry point that starts a `Runtime` without the server (a worker, a
  script) gets the same checks the server does, or does not start.
- An in-process caller, the test suite included, chooses its provider and
  names the identity and workspace of each run.

## Alternatives considered

- **Dev when the server binds to loopback** — rejected: a container binds
  `0.0.0.0` and is reached through a published port or a proxy, and a proxy on
  the same host makes every request arrive from loopback. The bind address does
  not say who can reach the server.
- **Dev when an environment variable is set** — rejected: a second place that
  decides the provider beside the file that already names it, and one that is
  inherited silently by every child process and CI job.
- **Default to dev and warn** — rejected: a warning in a log does not stop the
  requests it describes.
- **Refuse only at the server** — rejected: a runtime with no provider skipped
  its own permission checks and ran identity-less calls as `usr_default`. That
  is the same fail-open for any caller other than the server.
