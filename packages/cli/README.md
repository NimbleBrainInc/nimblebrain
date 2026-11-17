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

`--json` makes every command answer one JSON object, `{"ok": true, ...}` or
`{"ok": false, "error": "<CODE>", "fix": "..."}`, for scripts and coding agents.
`--yes` takes every default. `--agent claude-code|cursor|codex|none` names the agent to
connect.

Docs: [docs.nimblebrain.ai](https://docs.nimblebrain.ai)
