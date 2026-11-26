#!/usr/bin/env bash
# The CLI end to end against real Docker: what a coding agent does on a clean
# machine, then everything after. Usage: e2e.sh "<command that runs the CLI>".
# Run by .github/workflows/cli-e2e.yml; safe to run by hand on an x86_64 host
# with Docker, where it installs into a throwaway NIMBLEBRAIN_HOME.
set -euo pipefail

NB=${1:?usage: e2e.sh "<command that runs the CLI>"}
export NIMBLEBRAIN_HOME=${NIMBLEBRAIN_HOME:-$(mktemp -d)/nimblebrain-local}

step() { printf '\n== %s\n' "$*"; }
# Runs the CLI with --json; prints the object; never stops the script on a non-zero
# exit, but logs the exit code, so an empty answer can be told from a refusal.
nb() {
  local code=0
  $NB "$@" --json || code=$?
  echo "($* exited $code)" >&2
}
expect() { # expect <json> <jq filter that must be true> <what>
  if ! jq -e "$2" >/dev/null <<<"$1"; then
    echo "FAILED: $3"
    echo "$1" | jq .
    exit 1
  fi
  echo "ok: $3"
}

step "doctor"
out=$(nb doctor)
expect "$out" '.ok == true' "the machine passes every check"

step "init, unattended, as an agent runs it"
out=$(nb --yes --agent none)
expect "$out" '.ok == true and .model_key == "missing" and .local_model == null' "init succeeds, its answer saying no model is set"
expect "$out" '.health == "ok"' "the runtime is healthy"
expect "$out" '(.workspaces | length) >= 1' "a workspace exists"
expect "$out" '.url == "http://127.0.0.1:27246"' "the UI is on 127.0.0.1:27246"
# A development build has no telemetry destination, and its runtime gets no key.
expect "$out" '.telemetry.locked == "no_destination"' "a development build sends nothing"
if grep -q '^NB_TELEMETRY_KEY=.' "$NIMBLEBRAIN_HOME/.env"; then echo "FAILED: the runtime was given a telemetry key"; exit 1; fi
echo "ok: the runtime has no telemetry key"
mcp=$(jq -r '.workspaces[0].mcp' <<<"$out")
# The Compose project is the install's own, chosen at init and kept in its record.
project=$(jq -r .project "$NIMBLEBRAIN_HOME/install.json")
expect "$(jq -c . "$NIMBLEBRAIN_HOME/install.json")" '.phase == "ready" and (.project | test("^nimblebrain-local-[0-9a-f]{6}$"))' "the record names a ready install and its own project"

step "the workspace MCP endpoint lists tools, as a connected agent would"
# The endpoint speaks MCP 2026-07-28 only: no initialize handshake; every
# request carries the _meta envelope and the protocol-version and method headers.
code=$(curl -s -o /tmp/mcp-tools.txt -w '%{http_code}' -X POST "$mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"cli-e2e","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}}}')
echo "HTTP $code from $mcp"
head -c 300 /tmp/mcp-tools.txt; echo
test "$code" = "200"
grep -q '"tools"' /tmp/mcp-tools.txt
echo "ok: tools/list returns the workspace's tools"

step "the port is published on this machine only"
ports=$(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Ports}}')
echo "$ports"
grep -q '127.0.0.1:27246->8080' <<<"$ports"
# Not `! grep`: under `set -e` a negated command never stops the script.
if grep -q '0.0.0.0:27246' <<<"$ports"; then echo "FAILED: published on every interface"; exit 1; fi
echo "ok: 127.0.0.1 only"

step "init again changes nothing"
out=$(nb --yes)
expect "$out" '.already == true' "a rerun reports the install"

step "status"
out=$(nb status)
expect "$out" '.ok == true and .health == "ok" and .model_key == "missing"' "status reports health and no key"

step "open"
# A runner has no display, so nothing opens; the answer still carries the URL.
out=$(nb open)
expect "$out" '.ok == true and (.url | test("^http://127.0.0.1:")) and (.opened | type) == "boolean"' "open answers the URL"

step "mcp: list, and add and remove where the release can reach this machine"
expect "$(nb mcp list)" '.ok == true and (.servers | type) == "array"' "mcp list answers the workspace's servers"
if [ "$(nb status | jq -r .host_loopback)" = "true" ]; then
  # Nothing listens on port 1: the add succeeds with a warning, and the row is there to remove.
  out=$(nb mcp add http://127.0.0.1:1/mcp --name e2e-probe)
  expect "$out" '.ok == true and .serverName == "e2e-probe" and (.dialed | test("host.docker.internal"))' "mcp add stores the server and dials the host"
  expect "$(nb mcp list)" 'any(.servers[]; .serverName == "e2e-probe")' "mcp list shows it"
  expect "$(nb mcp remove e2e-probe)" '.ok == true' "mcp remove removes it"
else
  expect "$(nb mcp add http://127.0.0.1:1/mcp)" '.error == "UPDATE_REQUIRED"' "a release without host loopback needs update"
fi

step "logs"
out=$(nb logs)
expect "$out" '.ok == true and (.lines | length) > 0' "logs returns runtime lines"

# Three times: a run once ended early here, mid-restart, with the event loop drained.
for round in 1 2 3; do
  step "down, then up ($round of 3)"
  expect "$(nb down)" '.health == "down"' "down stops it"
  expect "$(nb status)" '.health == "down"' "status sees it down"
  expect "$(nb open)" '.error == "NOT_RUNNING"' "open does not start it"
  expect "$(nb up)" '.health == "ok"' "up brings it back"
done

step "key refuses without a terminal"
expect "$(nb key </dev/null)" '.error == "NEEDS_TERMINAL"' "key is for a person"

step "uninstall needs --yes, then removes everything"
expect "$(nb uninstall)" '.error == "CANCELLED"' "uninstall without --yes changes nothing"
expect "$(nb uninstall --yes)" '.removed == true' "uninstall --yes removes it"
test ! -e "$NIMBLEBRAIN_HOME"
test -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")"
test -z "$(docker ps -a -q --filter "label=com.docker.compose.project=$project")"
test -z "$(docker network ls -q --filter "label=com.docker.compose.project=$project")"
echo "ok: no folder, no volume, no containers, no network"

step "install again where one was removed"
out=$(nb --yes --agent none)
expect "$out" '.ok == true and .health == "ok" and .already != true' "a second install comes up as a new one"
again=$(jq -r .project "$NIMBLEBRAIN_HOME/install.json")
test "$again" != "$project"
echo "ok: the second install has its own project"
expect "$(nb uninstall --yes)" '.removed == true' "uninstall removes the second install"
test ! -e "$NIMBLEBRAIN_HOME"
test -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$again")"
test -z "$(docker ps -a -q --filter "label=com.docker.compose.project=$again")"
test -z "$(docker network ls -q --filter "label=com.docker.compose.project=$again")"
echo "ok: nothing is left of the second install"

printf '\nAll end-to-end checks passed.\n'
