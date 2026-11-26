# subscription-agent (prototype)

Runs NimbleBrain's agent turns on the Claude Code or Codex you are already signed in to, so
they are billed to your Claude or ChatGPT subscription instead of an API key.

```
NimbleBrain runtime ──ACP over HTTP──▶ subscription-agent ──spawns──▶ claude -p / codex exec
      ▲                                     │                              │
      └──── mcp/message (your tools) ◀──────┴── loopback MCP bridge ◀──────┘
```

- **The vendor's own CLI does the model calls.** The worker starts the unmodified `claude` or
  `codex` binary for each turn. It never reads, holds or forwards a login token: the CLI uses
  its own sign-in.
- **Subscription, never API pricing, is checked, not assumed.** The worker removes every API key
  variable from the CLI's environment, refuses to start unless `claude auth status` says
  `claude.ai` with a subscription (or `codex login status` says ChatGPT), and stops a Claude
  turn whose first line reports any API key source. It never uses `claude --bare`, which reads
  only `ANTHROPIC_API_KEY`.
- **Your NimbleBrain tools reach the CLI through the bridge.** Each turn gets a random loopback
  URL on the worker; every MCP request the CLI sends there is relayed over the ACP connection to
  the runtime's tool projection, which applies the run's checks. Claude Code runs with no
  built-in tools and none of your settings, hooks, plugins or CLAUDE.md. Codex ignores your
  `config.toml` but keeps a read-only shell, which it cannot turn off; each command shows in the
  turn.
- **Usage is counted, not priced.** Calls are reported as `claude-code-subscription:<model>` or
  `codex-subscription:codex`, names the catalog has no rates for, so the ledger records the
  tokens at $0.

## Run it

```bash
bun --no-env-file packages/subscription-agent/src/cli.ts claude   # :27290
bun --no-env-file packages/subscription-agent/src/cli.ts codex    # :27291
```

It prints what it bills, which tools the CLI gets, and the `execution` block to add to
`nimblebrain.json`. The runtime accepts the `claude-code` and `codex` drivers only under the
`dev` identity provider: the subscription is one person's, on their own machine.

## Limits of the prototype

- Calls the runtime makes outside a turn (the conversation title, a fold's summary) still go to
  the native engine's model and need its key.
- No spend cap: the door sends a run with spend accounts to the native engine (ADR-0062).
- Codex streams each message whole, not token by token.
- The runtime must reach the worker on loopback, so this runs against `bun run dev` /
  `dev:worktree`, not yet the Docker install `npx nimblebrain init` makes.
