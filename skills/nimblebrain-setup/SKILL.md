---
name: nimblebrain-setup
description: Sets up the open source NimbleBrain runtime on this machine with Docker Compose, then checks that it is healthy and answers one chat. Clones the newest release and starts it with the repository's own Compose file, pulling the published images on x86-64 and building them on Apple Silicon and other arm64 hosts. Use to run NimbleBrain locally. Triggers include "set up NimbleBrain", "install NimbleBrain locally", "run NimbleBrain on my machine".
license: Apache-2.0
compatibility: Docker Engine 24+ with Docker Compose v2 or later, running, with about 2 GB of free memory. git and curl. On arm64 hosts (Apple Silicon), also the Docker buildx plugin and about 5 GB of free disk. A model API key (Anthropic by default) for the chat; the rest works without one.
allowed-tools: Read Write Bash AskUserQuestion
metadata:
  area: setup
  version: "0.1.0"
  author: NimbleBrain
---

# NimbleBrain Setup

You are setting up NimbleBrain Platform, the open-source runtime that runs agents and MCP apps on your systems, in your own infrastructure, with any model, on the user's own machine. The route is the one in `docs.nimblebrain.ai/deploy/docker/`: a clone of this repository at its newest release, started with its own `docker-compose.yml`. Done means the health endpoint answers and the user has seen one chat reply.

Work through the steps in order, from step 1 every time, reruns included. Run each command yourself and read its output before the next step. When a step fails, look the symptom up in `references/TROUBLESHOOTING.md`, give the fix, and stop there. Do not improvise a different install route.

## Rules that hold for every step

- **The model key never passes through you.** Do not ask for it in chat. Do not open or print `.env`, and do not run `docker compose config`, `docker inspect` on a container, or a bare `env`: each prints the key. If the user pastes a key into chat anyway, do not use it; tell them it is in the transcript and that they may want to rotate it.
- **Write only inside the folder chosen in step 3.** Step 9 is the one exception, on its own yes.
- **Install nothing.** If Docker, git or buildx is missing, name the fix and stop.
- **The `dev` sign-in adapter is for this machine only.** It checks no credential: anyone who can reach the port is the admin. The Compose file publishes the port on `127.0.0.1` for that reason. Never widen it, tunnel it or put a proxy in front of it. A shared instance needs the `oidc` or `workos` adapter (`docs.nimblebrain.ai/config/instance-json/`).

## 1. Check Docker and the host

```bash
docker info >/dev/null && echo "docker: running"
docker compose version
git --version
docker info --format '{{.Architecture}}'
```

If a line prints an error, give its fix from the troubleshooting table and stop.

The last line is the architecture of the Docker host. `x86_64` is the **pull** route: the published images are `linux/amd64`. `aarch64` or `arm64` is the **build** route: there is no image to pull, so Compose builds both from the clone, about six minutes the first time. Anything else: say the runtime publishes no image for it and stop.

On the build route, also run `docker buildx version`. If it fails, stop before writing anything: the runtime's Dockerfile needs buildx.

## 2. Find the newest release

```bash
git ls-remote --tags --refs https://github.com/NimbleBrainInc/nimblebrain.git 'v*' | awk -F/ '{print $3}' | grep -v -e '-' | sort -V | tail -1
```

That prints the newest release tag, for example `v1.2.3`. A tag with a hyphen is a pre-release and is left out. `<tag>` in every later command is this value.

## 3. Say what will happen, and wait for a yes

Say this in three lines, in your own words, then wait:

1. I will clone NimbleBrain `<tag>` into one folder (default `~/nimblebrain-local`), write two small files there, and start two containers. Pull route: about 2 GB of images. Build route: a build of about six minutes and about 4 GB of images and build cache. The web UI will be at `http://localhost:27246`.
2. You will put your own model API key in a file in that folder. I will never ask for it, print it or show it. Without a key everything starts, but chat does not work.
3. There is no account and no sign-in; it is reachable from this machine only. I will finish by showing how to stop it and how to remove everything.

Use the default folder unless the user names another. `<folder>` in every later command is its absolute path.

```bash
ls -a <folder> 2>/dev/null || echo "free"
grep -qx 'COMPOSE_PROJECT_NAME=nimblebrain-setup' <folder>/.env 2>/dev/null && echo "ours"
```

A folder that printed `ours` is an earlier run of this skill: reuse it and skip the clone in step 4. Any other folder that exists and is not empty, a developer's checkout of this repository included, is not ours: ask for another folder. On a Mac with Colima, keep the folder under the home folder, which is all Colima shares with its VM by default.

## 4. Clone the release and check it

```bash
git clone --depth 1 --branch <tag> https://github.com/NimbleBrainInc/nimblebrain.git <folder>
grep -cF ':${NIMBLEBRAIN_TAG:-latest}' <folder>/docker-compose.yml
grep -cF '"127.0.0.1:27246:8080"' <folder>/docker-compose.yml
```

git warns that HEAD is detached and that the tag is not a commit; both are expected. The two checks must print `2` and then `1`: both images take their tag from `NIMBLEBRAIN_TAG`, and the web port is published on this machine only. On any other output, stop: this release predates this skill, and its Compose file would publish the no-login UI on the network. Tell the user, and offer to remove the folder you just created.

## 5. Write the two files

Write each only if it is missing. Never overwrite or merge into an existing file. Write `.env` first: it is what marks the folder as this skill's on a rerun.

`<folder>/.env` holds settings for Compose. The project name keeps this install's containers and its `nimblebrain-setup_workspace` volume apart from any other checkout of this repository. The tag keeps the images on the release you cloned.

```bash
COMPOSE_PROJECT_NAME=nimblebrain-setup
NIMBLEBRAIN_TAG=<tag>
```

`<folder>/instance.json` names the identity provider. The runtime does not start without it.

```json
{ "auth": { "adapter": "dev" } }
```

Git ignores both files, so the clone stays clean.

## 6. The model key

Compose takes a variable from the shell before it reads `.env`, so first see which key variables this shell exports. This prints names only:

```bash
for v in ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_GENERATIVE_AI_API_KEY GREENPT_API_KEY NEBIUS_API_KEY XAI_API_KEY; do printenv "$v" >/dev/null && echo "$v: exported in this shell"; done; true
```

If any is exported, tell the user the shell's value will be used and the same line in `.env` ignored, and ask which they want. It may be a work key they did not mean to spend. To use the file's key, start step 7's command as `env -u <NAME> docker compose ...`, with one `-u <NAME>` for each exported variable.

Otherwise tell the user, with the real path filled in:

> Open `<folder>/.env` in your editor, add one line below the two that are there, and save:
> `ANTHROPIC_API_KEY=<your key>`
> Tell me when it is saved. I will not print the file.

Keys for other providers go in the same file under their own names. If the user has no key yet, go on without one, skip step 8, and say so in the report.

## 7. Start it and check it

Stop and ask, without starting anything, if this prints a project whose CONFIG FILES is not `<folder>/docker-compose.yml`: another copy of this setup owns the name and its data.

```bash
docker compose ls -a --filter name=nimblebrain-setup
```

Then start it. Pull route:

```bash
cd <folder> && docker compose up -d
```

Build route:

```bash
cd <folder> && docker compose up -d --build
```

Until a key is set, every `docker compose` command warns that the `ANTHROPIC_API_KEY` variable is not set; that is expected. The `web` container starts once `platform` passes its health check. Then confirm the port is published on this machine only, and poll health for up to 2 minutes:

```bash
cd <folder> && docker compose port web 8080
for i in $(seq 1 24); do curl -fsS http://localhost:27246/v1/health && break; sleep 5; done
```

The first command must print `127.0.0.1:27246`. If it prints `0.0.0.0` or any other address, run `docker compose down` and stop. Healthy is `{"status":"ok"}`; a curl error before it is normal while the containers start. If the ok does not arrive, run `docker compose ps` and `docker compose logs --tail 50 platform` and use the troubleshooting table.

## 8. One real chat

Health shows the runtime is up, not that the key works. Ask the user:

> Open http://localhost:27246 and send: `What can you help me with?`
> Tell me whether you got a reply.

There is no sign-in screen. Report success only after the user confirms the reply. An error in the chat means the key or the provider; see the table.

## 9. Report

Give the user all of this, briefly:

- **Where it is:** `http://localhost:27246`, the folder, the release, and whether the images were pulled or built.
- **Chat:** confirmed, or not tested because there is no key yet. To add one later, put the line in `<folder>/.env`, then `docker compose up -d` from the folder.
- **Stop it:** `docker compose down` from the folder. Until then it starts again whenever Docker starts. Data stays in the volume.
- **Update it:** `references/TROUBLESHOOTING.md`, under "Updating".
- **Remove everything:** `docker compose down -v --rmi all` from the folder removes the containers, the network, the volume with every conversation in it, and this release's images; then `rm -rf <folder>`, which holds the key. Images of earlier releases, if you updated, show in `docker images 'ghcr.io/nimblebraininc/*'`. Offer to run these, and run them only on a clear yes.
- **Telemetry:** the runtime collects anonymous usage telemetry (`nimblebrain.ai/telemetry/`). `docs.nimblebrain.ai/using/telemetry/` says how to turn it off.
- **What this did not do:** it created no account, installed no software and no connectors, and changed nothing outside the folder and Docker.

Then offer, as its own question, to connect the user's coding agent to this instance over MCP. Say that it lets the agent call every tool in the workspace, and that with the `dev` adapter any program on this machine that reaches the port can call the admin tools too. On yes, follow `docs.nimblebrain.ai/connect/external-clients/`, using the host `http://localhost:27246` with the `/mcp/ws_<id>` path the user copies from **Workspace settings → MCP**.

## References

- `references/TROUBLESHOOTING.md` - symptom, cause and fix for each step, and how to update
