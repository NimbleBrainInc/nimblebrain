# nimblebrain

Install and run [NimbleBrain](https://github.com/NimbleBrainInc/nimblebrain), the
open-source runtime for agents and MCP apps, on your own machine, and connect your
coding agent to it.

```bash
npx nimblebrain
```

It checks the machine, starts NimbleBrain in Docker at `http://127.0.0.1:27246`, and
connects your coding agent to a workspace over MCP. Run it again any time: on a
machine that already has NimbleBrain it reports what is there.

You need Docker with Compose v2, about 2 GB of memory for Docker, and Node.js 20 or
later.

## Commands

| Command | Does |
|---|---|
| `init` (default) | Check the machine, start NimbleBrain, connect your coding agent |
| `doctor` | Check Docker, Compose, architecture, memory and the port; installs nothing |
| `status` | Version, health, URL and each workspace's MCP URL |
| `key` | Enter the model key at a hidden prompt |
| `up` / `down` | Start or stop it; data survives `down` |
| `logs` | Recent log lines |
| `update` | Move to the newest release, keeping data |
| `uninstall` | Remove it and its data |
| `telemetry [on\|off\|status]` | Whether this install sends anonymous usage data |
| `mcp add <url>` | Add an MCP server you run on this machine to a workspace (`--name`, `--workspace`) |
| `mcp list` / `mcp remove <name>` | The servers in a workspace, or remove one |

`--json` makes every command answer one JSON object, `{"ok": true, ...}` or
`{"ok": false, "error": "<CODE>", "fix": "..."}`, for scripts and coding agents.
`--yes` takes every default. `--agent claude-code|cursor|codex|none` names the agent to
connect.

## Usage data

Nothing is sent until you say yes. `init` asks once in your terminal; run by a coding
agent, it sends nothing and hands the agent the question to ask you, which it answers
with `npx nimblebrain telemetry on` or `off`. `DO_NOT_TRACK=1` keeps it off. What is
sent and what never is: [Telemetry](https://docs.nimblebrain.ai/using/telemetry/).

Docs: [docs.nimblebrain.ai](https://docs.nimblebrain.ai)
