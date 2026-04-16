# Contributing to NimbleBrain

Thanks for your interest in contributing. This guide covers how to set up the development environment, run tests, and submit changes.

## Prerequisites

- [Bun](https://bun.sh) >= 1.1
- [Node.js](https://nodejs.org) >= 22 (required by some web tooling)
- [mpak CLI](https://mpak.dev) (required for smoke tests)
- Docker (optional, for container-based development)

## Setup

```bash
git clone https://github.com/NimbleBrainInc/nimblebrain.git
cd nimblebrain

# Install API dependencies
bun install

# Install web client dependencies
cd web && bun install && cd ..

# Copy the environment template and fill in at least one LLM provider key
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY (or OPENAI_API_KEY / GEMINI_API_KEY)
```

## Running Locally

```bash
bun run dev        # API (:27247, auto-restart) + web client (:27246, HMR) — single terminal
bun run dev:api    # API only
bun run dev:web    # Web client only
bun run dev:tui    # Interactive TUI (no web client)
```

Output is prefixed `[api]` / `[web]`. Ctrl+C stops both.

## Verification

Before submitting a PR, run the full verification suite:

```bash
bun run verify     # lint → typecheck → unit tests → web tests → smoke tests
```

Individual steps:

```bash
bun run lint       # Biome linter (src/ only)
bun run check      # TypeScript type check
bun run test       # Unit tests
bun run smoke      # Integration/smoke tests (requires mpak + mcp-servers/echo)
bun run eval       # LLM evals — requires ANTHROPIC_API_KEY (not in CI)
```

Smoke tests require the `mcp-servers/echo` bundle to be available as a sibling directory. If you cloned from the monorepo, it's already there. If not, skip smoke tests with `bun run lint && bun run check && bun run test`.

LLM evals (`test/eval/`) send real messages to Claude and assert on agent behavior (e.g., correct tool discovery). They cost real money and are not part of `verify`. Run them manually when changing prompts, skills, or tool surfacing logic.

## Code Style

- Formatter and linter: [Biome](https://biomejs.dev). Run `bun run format` to auto-fix.
- TypeScript strict mode is enabled. No `any` without justification.
- No default exports in `src/` — named exports only.
- Tests live in `test/` and mirror the `src/` directory structure.

## Making Changes

1. Fork the repo and create a branch from `main`.
2. Make your changes in `src/` or `web/src/`.
3. Add or update tests in `test/` for any logic changes.
4. Run `bun run verify` and ensure it passes cleanly.
5. Open a pull request against `main`.

## Pull Request Guidelines

- Keep PRs focused — one logical change per PR.
- Describe *why* the change is needed, not just what it does.
- Reference any related issues.

## Reporting Issues

Use [GitHub Issues](https://github.com/NimbleBrainInc/nimblebrain/issues). Include:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Bun version (`bun --version`) and OS

## License

By contributing, you agree that your contributions will be licensed under the [Apache License, Version 2.0](LICENSE).
