# nimblebrain

Install and run [NimbleBrain](https://github.com/NimbleBrainInc/nimblebrain), the
open-source runtime for agents and MCP apps, on your own machine, and connect your
coding agent to it.

```bash
npx nimblebrain
```

It checks the machine, asks what runs NimbleBrain's agents (your Claude subscription
through Claude Code, your ChatGPT plan through Codex, an API key, or a local model
through Ollama), starts NimbleBrain in Docker at `http://127.0.0.1:27246`, connects your
coding agent to a workspace over MCP, and opens it in your browser
(`--no-open` skips that). Run it again any time: on a
machine that already has NimbleBrain it reports what is there.

You need Docker with Compose v2, about 2 GB of memory for Docker, and Node.js 20 or
later.

## Commands

| Command | Does |
|---|---|
| `init` (default) | Check the machine, start NimbleBrain, connect your coding agent |
| `doctor` | Check Docker, Compose, architecture, memory and the port; installs nothing |
| `status` | Version, health, URL and each workspace's MCP URL |
| `open` | Open the web UI in your default browser |
| `use [claude\|codex\|api\|local] [model]` | Choose what runs NimbleBrain's agents; with none named, it asks |
| `key` | Enter the model key at a hidden prompt |
| `local-model [model]` | Prepare another Ollama model |
| `up` / `down` | Start or stop it; data survives `down` |
| `logs` | Recent log lines |
| `update` | Move to the newest release, keeping data, and refresh your agent's `nimblebrain` skill |
| `uninstall` | Remove it and its data |
| `telemetry [on\|off\|status]` | Whether this install sends anonymous usage data |
| `mcp add <url>` | Add an MCP server you run on this machine to a workspace (`--name`, `--workspace`) |
| `mcp list` / `mcp remove <name>` | The servers in a workspace, or remove one |

`--json` makes every command answer one JSON object, `{"ok": true, ...}` or
`{"ok": false, "error": "<CODE>", "fix": "..."}`, for scripts and coding agents.
`--yes` takes every default, but never chooses for you what runs NimbleBrain's agents:
`init --use claude|codex|api|local` does, and without it a coding agent gets the
question to ask you in `model_source`. `--agent claude-code|cursor|codex|none` names the agent to
connect; at a terminal without it, `init` lists the agents it finds here and defaults to the one
that also runs NimbleBrain's agents, else the first one found, else none. Without a terminal or
`--agent`, nothing is connected. `npx nimblebrain help --json` lists every command with the fields it answers, every flag and every error code.

When a newer CLI or NimbleBrain release exists, the CLI says so on stderr after its
answer (once a day at most; it never updates anything itself).
`NIMBLEBRAIN_NO_UPDATE_CHECK=1` turns that off.

## A second install

```bash
npx nimblebrain --home ~/.nimblebrain-beta --runtime vX.Y.Z-rc.N
```

Each `--home` is its own install, beside the one you use every day. When port 27246 is
taken, the new install takes the next free port 100 on (27346, 27446, …), says what holds
it, and keeps that port for every later command. Your coding agent gets it under its own
name, `nimblebrain-<folder>` (here `nimblebrain-beta`), beside `nimblebrain`, and its
`uninstall` removes only that one. Pass the same `--home` to every command for it; a port
you pass with `--port` is used as given, or refused when it is taken.

## Your Claude or ChatGPT subscription instead of a model key

```bash
npx nimblebrain use claude   # or: use codex
```

On a Mac with Docker Desktop, NimbleBrain's agents can run on the Claude Code or Codex
you are already signed in to, so each turn is billed to your Claude or ChatGPT
subscription and no API key is needed.

```
NimbleBrain (Docker) ──ACP──▶ agent worker (this machine) ──runs──▶ claude -p / codex exec
        ▲                              │                                   │
        └──── your workspace's tools ◀─┴──── loopback MCP bridge ◀─────────┘
```

- **The vendor's own CLI makes the model calls.** `use` starts an agent worker on this
  machine, which runs the unmodified `claude` or `codex` for each turn. It never reads,
  holds or forwards your login.
- **Your subscription is checked, not assumed.** The worker removes every API key
  variable from the CLI's environment, refuses to start unless `claude auth status` says
  you are signed in with a Claude subscription (or `codex login status` says ChatGPT),
  and stops a Claude turn that reports any API key source. It never uses `claude --bare`,
  which reads only `ANTHROPIC_API_KEY`.
- **Your workspace's tools reach the CLI through the worker.** Each turn gets a private
  loopback URL; every tool call is relayed to NimbleBrain, which applies the run's checks.
  Claude Code runs with no built-in tools and none of your settings, hooks, plugins or
  CLAUDE.md. Codex ignores your `config.toml` but keeps a read-only shell it cannot turn
  off; each command shows in the turn.
- **The worker listens on 127.0.0.1 only.** NimbleBrain's container reaches it at
  `host.docker.internal`, which Docker Desktop forwards to this machine. On Linux that
  name reaches the Docker bridge instead, so `use` refuses there for now.
- **Usage is counted, not priced.** Turns are recorded with their tokens at $0.

Claude Code's turns run on Sonnet, which answers a chat turn faster than Opus; pick
another with `use claude --model opus` (or `haiku`, or a full model id). Codex runs on its
own default unless `--model` names one. A conversation's title and history summary run
with no tools, and on Claude Code on Haiku, so they take a couple of seconds.

`status` shows which source is in use and whether its worker answers. The worker is a
login item (a LaunchAgent for your user, running a copy of the CLI kept in the install's
folder), so launchd starts it when you log in and again if it crashes; `down` removes it
and `up` puts it back. `use api` or `use local` goes back to the model key
or a local model; a saved one stays while you run on a subscription, for runs with a
spend budget. The worker logs to `agent-worker.log` in the install's folder, one `timeline` line per turn
saying where its time went (start, the model request, the first token, retries, the plan's
rate limit), never its text; a turn that shows nothing for 15 seconds tells you it is waiting. It needs
NimbleBrain v0.87.0 or newer (v0.87.1 for titles and summaries on Haiku); `update` brings it.

## Usage data

Nothing is sent until you say yes. `init` asks once in your terminal; run by a coding
agent, it sends nothing and hands the agent the question to ask you, which it answers
with `npx nimblebrain telemetry on` or `off`. `DO_NOT_TRACK=1` keeps it off. What is
sent and what never is: [Telemetry](https://docs.nimblebrain.ai/using/telemetry/).

Docs: [docs.nimblebrain.ai](https://docs.nimblebrain.ai)
