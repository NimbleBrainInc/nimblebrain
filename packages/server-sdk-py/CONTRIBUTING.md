# Contributing to nimblebrain-server-sdk

The package lives in `packages/server-sdk-py/` of the NimbleBrain repository and is released on
its own schedule. Its user documentation is the [Server SDK section](https://docs.nimblebrain.ai/server-sdk/quickstart/)
of docs.nimblebrain.ai, whose source is `docs/` in the same repository: a change to the public
API and its documentation land in one pull request.

## Checks

```bash
cd packages/server-sdk-py
uv sync --all-extras --python 3.13
uv run ruff check src/ tests/ scripts/ examples/
uv run ruff format --check src/ tests/ scripts/ examples/
uv run ty check src/ tests/ scripts/ examples/
DB_TEST_URL=postgresql+asyncpg://postgres@127.0.0.1:5432/postgres uv run pytest --cov=nimblebrain_server_sdk
```

- **The `[db]` and `[outbox]` suites need a real Postgres** at `DB_TEST_URL`, a superuser URL:
  `docker run -d -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:5432:5432 postgres:16-alpine`.
  They create their own login roles and run their sessions as a role row-level security
  applies to. Without a reachable Postgres they skip locally and fail under CI.
- **Give the suite its own Postgres instance.** The outbox reads below the instance-wide
  snapshot horizon, so a transaction open anywhere on the instance holds its polls back.
- **Pull requests run** lint, format, type check and tests on Python 3.13 and 3.14 with every
  extra, check the core installed with no extra (`scripts/check_core_only.py`), and inspect the
  built wheel and sdist (`scripts/check_dist.py`). A weekly run repeats them on the newest
  dependency versions that resolve.

## What the tests pin

- **The public names and call shapes** (`tests/test_public_api.py` and each extra's
  `test_public_api.py`). Adding a name means adding it there.
- **The wire**: extension identifiers, `_meta` keys, the error results, metric families and log
  lines, against golden files.
- **The SQL `[db]` renders**, byte for byte. It is a schema contract that consumers' migrations
  replay, so a change to it needs a migration note in the changelog.
- **The README's code.** Every `python` block in `README.md` is a file under `examples/`,
  named by the `<!-- example: ... -->` comment above it and held equal by
  `tests/test_readme.py`. Edit the example, then copy it into the README. The examples are
  linted, type-checked and run with the suite.

## Skills conformance

The upstream MCP conformance suite's SEP-2640 server scenarios run against
`tests/conformance_server.py`, which serves the fixture skill and a generated one:

```bash
uv run python tests/conformance_server.py --port 3001            # or --server mcpserver
git clone https://github.com/modelcontextprotocol/conformance && cd conformance && npm ci
for s in enumeration manifest directory; do
  npm start -- server --url http://127.0.0.1:3001/mcp --scenario sep-2640-skills-$s
done
```

Both adapters pass every check. On FastMCP the manifest scenario warns
(`sep-2640-meta-prefix`) because FastMCP stamps its own `fastmcp` `_meta` key on every
resource; the `directory` checks skip because `resources/directory/read` is not implemented.

## Versions and deprecation

`0.x` is pre-stable: a minor release may change the Python API and a patch release never does.
To remove or rename a public name, first deprecate it for at least one minor release: keep it
working, emit a `DeprecationWarning` that names the replacement, and list it under
"Deprecated" in `CHANGELOG.md`. The `ai.nimblebrain/*` identifiers and `_meta` keys do not
change within a major.

## Releases

A release is a `server-sdk-py/v<version>` git tag on a commit of `main`; only a repository
admin can create one. The tag runs `.github/workflows/release-server-sdk-py.yml`, which checks
the tag against `pyproject.toml`, verifies the source, builds once, tests and inspects the
built files, publishes those files to PyPI by trusted publishing, and creates the GitHub
Release.

1. In a pull request: set `version` in `pyproject.toml`, run `uv lock`, and move the
   changelog's `[Unreleased]` entries under the new version.
2. After it merges: `git tag -a server-sdk-py/v<version> <merge-sha> -m "server-sdk-py v<version>"`
   and `git push origin server-sdk-py/v<version>`.
