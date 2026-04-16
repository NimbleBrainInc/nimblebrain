# Changelog

## [Unreleased]

### Breaking

- **Rename `files__write` → `files__create`.** The tool always generates a new id per call and never updates, so `create` matches both its semantics and how the model naturally calls it. External clients hand-coded against `files__write` must switch. In-process UI clients updated.
- **`nb__search.query` is now optional.** The schema previously declared `required: ["query"]` but the handler already defaulted to an empty string. Additive/relaxing — existing callers unaffected; new callers may omit `query` to list everything in scope.

### Fixed

- `InlineSource.execute()` now validates input against the tool's declared `inputSchema` before dispatching. Closes the bug class where malformed tool calls via `/mcp` leaked Node-internal errors (`fs.readFile(undefined)`, `Buffer.from(undefined)`) as tool results.

### Removed

- Legacy standalone files MCP server at `src/bundles/files/` — dead code superseded by the inline source months ago.

### Other

- Auto-build bundle UIs during Docker image build and local `dev`.
- Update GitHub Actions workflows to latest major versions.

## [0.2.0] - 2026-04-15

- Add `dev:docs-demo` script for running the docs-demo environment with a preset dev identity.

## [0.1.0] - 2026-04-07

Initial public release.
