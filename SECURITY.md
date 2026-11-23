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
- **Fix targets,** from confirmation:
  - Critical: 72 hours
  - High: 7 days
  - Medium: 14 days
  - Low: the next release

## Scope

The following are in scope:

- The NimbleBrain runtime and agentic engine (`src/engine/`, `src/runtime/`)
- The HTTP API server (`src/api/`)
- The web client (`web/`)
- The server entry point (`src/cli/`) and the `npx nimblebrain` installer (`packages/cli/`)
- The published container images and npm packages
- The plugin catalog the runtime downloads from (catalog.nimblebrain.ai)
- Connector lifecycle and env isolation (`src/connectors/`)
- Authentication and session management
- MCP server endpoint (`/mcp`)

A vulnerability in a third-party dependency is in scope when it affects NimbleBrain as published (the container images and npm packages). Report it to us as well as upstream.

The following are out of scope:

- Denial of service attacks against the public API
- Social engineering attacks

## Disclosure Policy

We follow coordinated disclosure. We will:

1. Confirm the vulnerability and its scope
2. Develop and test a fix
3. Release the fix and publish a security advisory as a GitHub Security Advisory on this repository (watch the repository's security advisories to be notified)
4. Credit the reporter (unless anonymity is requested)

We ask that you give us reasonable time to address the issue before any public disclosure.

## Safe Harbor

We will not pursue legal action against anyone who researches and reports a vulnerability in good faith under this policy: who avoids privacy violations, data destruction and service disruption, uses only their own accounts or installations, and gives us reasonable time to fix the issue before disclosing it.

## Supported Versions

Security fixes ship in the next release. We support the latest release; upgrade to it to receive a fix. For a deployment that cannot upgrade, we can issue a hotfix release on request.
