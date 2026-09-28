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
- **No `instance.json`, no server.** `serve` refuses to start and says what to
  write for dev and for a real provider. The HTTP server is the layer that
  admits requests, so it holds the check: it does not start without a provider,
  and it never constructs one of its own.
- **The runtime is the one owner of the provider.** It builds the provider
  `instance.json` names (or takes one from an in-process caller), and the server
  authenticates with that one. The server has no provider of its own, so the
  identity a request carries is the identity the runtime's permission checks
  judge.
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
- A `Runtime` started in-process from a workdir with no `instance.json` has no
  provider. Its permission checks then let every call through, and a call with
  no identity runs as `usr_default`. Only an in-process caller reaches that
  runtime; the server refuses to serve it.

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
- **Refuse in `Runtime.start` too** — not taken: the runtime is also started
  in-process by callers that admit no requests, such as the test suite, and the
  refusal belongs to the layer that admits them.
