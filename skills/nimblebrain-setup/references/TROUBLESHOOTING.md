# Troubleshooting

Find the symptom, give the fix, and stop. Run every `docker compose` command from the folder chosen in step 3. The rule about never printing the key holds while diagnosing.

| Symptom | Cause | Fix |
|---------|-------|-----|
| `docker: command not found` | Docker is not installed. | The user installs Docker Desktop or Docker Engine from `https://docs.docker.com/get-docker/`, then runs the skill again. |
| `Cannot connect to the Docker daemon` or `failed to connect to the docker API` | Docker is installed but not running. | The user starts Docker Desktop (or the Docker service) and waits until `docker info` succeeds. |
| `permission denied while trying to connect to the docker API` | Docker is running, but this user may not use its socket. On Linux the user is usually not in the `docker` group. | The user follows `https://docs.docker.com/engine/install/linux-postinstall/`, signs in again, and runs the skill again once `docker info` succeeds. Do not run Docker as root for them. |
| `docker: 'compose' is not a docker command` | The Compose plugin (v2 or later) is missing. The compose file needs it. | Update Docker Desktop, or install the Compose plugin: `https://docs.docker.com/compose/install/`. |
| `docker buildx version` fails, or a build prints `buildx Docker CLI plugin not found: falling back to the classic builder` or `BuildKit is enabled but the buildx component is missing or broken` (build route) | The buildx plugin is missing. The runtime's Dockerfile needs it, and on an arm64 host there is no published image to pull instead. Docker Desktop includes buildx; Colima and a bare Docker CLI often do not. | The user installs the plugin, following `https://github.com/docker/buildx#installing`. With Homebrew that is `brew install docker-buildx`, then the `cliPluginsExtraDirs` entry from its caveat goes into `~/.docker/config.json`. Docker Desktop users update Docker Desktop. Run the skill again once `docker buildx version` prints a version. |
| `git: command not found` | git is not installed, and the skill clones the runtime repository. | The user installs git from `https://git-scm.com/downloads`, then runs the skill again. |
| `no matching manifest for linux/arm64/v8 in the manifest list entries` | The Docker host is arm64, and the published images are `linux/amd64` only. The pull route ran on an arm64 host. | Run `docker info --format '{{.Architecture}}'`. On `aarch64` or `arm64`, start with `docker compose up -d --build`, the build route from step 1. Do not set `DOCKER_DEFAULT_PLATFORM=linux/amd64`: under QEMU the runtime crashes with `CPU lacks AVX support`. |
| `COPY failed: no source files were specified` at `COPY --chown=1000:1000 --parents src/platform/*/ui/ ./`, after `buildx Docker CLI plugin not found: falling back to the classic builder` | The build ran without buildx. The classic builder does not support `COPY --parents`. | Same fix as the missing buildx row. Then `docker compose up -d --build` again. |
| The platform logs show `CPU lacks AVX support` and Bun crashes; `dependency failed to start: container ... is unhealthy` | amd64 images are running under QEMU emulation on an arm64 host, usually because `DOCKER_DEFAULT_PLATFORM=linux/amd64` is set. | `docker compose down`, unset `DOCKER_DEFAULT_PLATFORM`, and use the build route. |
| `The "ANTHROPIC_API_KEY" variable is not set. Defaulting to a blank string.` | No key line in `.env`, or the line is misspelled, and the variable is not exported. The containers still start; chat fails until a key is set. | If the user chose to go on without a key, this is expected. Otherwise the user adds `ANTHROPIC_API_KEY=<key>` to `<folder>/.env`, then `docker compose up -d`. |
| `bind source path does not exist: .../instance.json` | `instance.json` is missing from the folder. With Colima, the folder can also be outside the home folder, which the Colima VM does not see. | If the file is missing, write it as in step 5; the Compose file refuses to create it, so a missing file is an error and never an empty directory. If the file is there and the folder is outside the home folder on Colima, `docker compose down`, then ask the user for a folder under the home folder. |
| `platform` restarts or is `unhealthy`; the logs name `instance.json` | The file is malformed or names an unknown adapter. The runtime stops at startup on a bad auth config. | Report the validation error line from the logs. If the file names an adapter other than `dev`, stop: the user fixes it with `docs.nimblebrain.ai/config/instance-json/`. Only if it was this skill's `dev` file, and only on the user's yes, rewrite it with the step 5 contents, then `docker compose up -d`. |
| `port is already allocated` or `address already in use` for 27246 | Another process holds the port, often the stack of a runtime checkout. On a rerun it may be this same stack. | `docker compose ps` in the folder. If this stack is up, it is already running. Otherwise the user stops the other process; do not change the port without asking. |
| The health check does not answer after 2 minutes | The platform is still starting, or it exited. | `docker compose ps`, then `docker compose logs --tail 50 platform`. Report the last error line as written. |
| `platform` exits with code 137 | Out of memory. | Give Docker at least 2 GB of memory in its settings, then `docker compose up -d`. |
| A pull, clone or build fails with a timeout or `no such host` | No network, or a registry or package source is unreachable. The pull route needs `ghcr.io`. The build route needs GitHub, Docker Hub (base images and the Dockerfile syntax image) and the package sources the runtime's Dockerfile installs from. | Check the connection, then retry the step that failed: the `git clone` from step 4, or step 7's `docker compose up`. |
| Pull fails with `denied`, `unauthorized` or `manifest unknown` | `NIMBLEBRAIN_TAG` in `.env` names a tag with no published image, or Docker sent a stale `ghcr.io` login. Both images are public and need no login. | Report the exact error line and stop. Do not change the image and do not log in. The user can clear a stale login with `docker logout ghcr.io`. |
| The UI loads but the chat shows an error | No key, or the key is wrong, expired or out of credit, or belongs to a provider other than the one selected. | The user adds or corrects the line in `.env`, then `docker compose up -d` so the container picks it up. A restart alone does not reload `.env`. |
| The user edited `.env` but the old key is still used | A variable exported in the shell overrides the same line in `.env`. | Run the step 6 check. Start with `env -u <NAME> docker compose up -d` to use the file's key. |
| The coding agent connects, then fails with `-32022` or "unsupported protocol version" | The client speaks an MCP revision older than `2026-07-28`. | Update the client. The endpoint serves that revision only. |

## Updating

Find the newest release as in step 2. Then, from the folder:

```bash
git fetch --depth 1 origin tag <tag>
git checkout <tag>
grep -v '^NIMBLEBRAIN_TAG=' .env > .env.new; echo 'NIMBLEBRAIN_TAG=<tag>' >> .env.new; mv .env.new .env
```

The last line changes the tag in `.env` without printing the file; if you had restricted the file's permissions, set them again. Run the two checks from step 4 again and stop on any other output. Then `docker compose pull` and `docker compose up -d` on the pull route, or `docker compose up -d --build` on the build route.

Data stays in the `nimblebrain-setup_workspace` volume across an update.
