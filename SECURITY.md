# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in NimbleBrain, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, email **security@nimblebrain.ai** with:

1. A description of the vulnerability
2. Steps to reproduce
3. The affected component (runtime, API server, web client, CLI, bundles)
4. Any potential impact assessment

## Response Timeline

- **Acknowledgment:** Within 48 hours of your report
- **Initial assessment:** Within 5 business days
- **Fix timeline:** Depends on severity, but we aim for:
  - Critical: 72 hours
  - High: 1 week
  - Medium: 2 weeks
  - Low: Next release cycle

## Scope

The following are in scope:

- The NimbleBrain runtime and agentic engine (`src/engine/`, `src/runtime/`)
- The HTTP API server (`src/api/`)
- The web client (`web/`)
- The CLI (`src/cli/`)
- Bundle lifecycle and env isolation (`src/bundles/`)
- Authentication and session management
- MCP server endpoint (`/mcp`)

The following are out of scope:

- Vulnerabilities in third-party dependencies (report these upstream)
- Denial of service attacks against the public API
- Social engineering attacks

## Disclosure Policy

We follow coordinated disclosure. We will:

1. Confirm the vulnerability and its scope
2. Develop and test a fix
3. Release the fix and publish a security advisory
4. Credit the reporter (unless anonymity is requested)

We ask that you give us reasonable time to address the issue before any public disclosure.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x.x   | Yes (current development) |
