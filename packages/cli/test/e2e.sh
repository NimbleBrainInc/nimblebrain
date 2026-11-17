#!/usr/bin/env bash
# The CLI end to end against real Docker: what a coding agent does on a clean
# machine, then everything after. Usage: e2e.sh "<command that runs the CLI>".
# Run by .github/workflows/cli-e2e.yml; safe to run by hand on an x86_64 host
# with Docker, where it installs into a throwaway NIMBLEBRAIN_HOME.
set -euo pipefail

NB=${1:?usage: e2e.sh "<command that runs the CLI>"}
export NIMBLEBRAIN_HOME=${NIMBLEBRAIN_HOME:-$(mktemp -d)/nimblebrain-local}

step() { printf '\n== %s\n' "$*"; }
# Runs the CLI with --json; prints the object; never stops the script on a non-zero exit.
# The exit code goes to stderr (the log), so a failure shows how the process ended.
nb() {
  local rc=0
  $NB "$@" --json || rc=$?
  echo "(nimblebrain $* exited $rc)" >&2
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
expect "$out" '.error == "MODEL_KEY_MISSING"' "init ends asking for a model key"
expect "$out" '.health == "ok"' "the runtime is healthy"
expect "$out" '(.workspaces | length) >= 1' "a workspace exists"
expect "$out" '.url == "http://127.0.0.1:27246"' "the UI is on 127.0.0.1:27246"
mcp=$(jq -r '.workspaces[0].mcp' <<<"$out")

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
ports=$(docker ps --filter "label=com.docker.compose.project=nimblebrain-local" --format '{{.Ports}}')
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

step "logs"
out=$(nb logs)
expect "$out" '.ok == true and (.lines | length) > 0' "logs returns runtime lines"

step "down, then up"
expect "$(nb down)" '.health == "down"' "down stops it"
expect "$(nb status)" '.health == "down"' "status sees it down"
expect "$(nb up)" '.health == "ok"' "up brings it back"

step "key refuses without a terminal"
expect "$(nb key </dev/null)" '.error == "NEEDS_TERMINAL"' "key is for a person"

step "uninstall needs --yes, then removes everything"
expect "$(nb uninstall)" '.error == "CANCELLED"' "uninstall without --yes changes nothing"
expect "$(nb uninstall --yes)" '.removed == true' "uninstall --yes removes it"
test ! -e "$NIMBLEBRAIN_HOME"
test -z "$(docker volume ls -q --filter name=^nimblebrain-local_workspace$)"
test -z "$(docker ps -a -q --filter label=com.docker.compose.project=nimblebrain-local)"
echo "ok: no folder, no volume, no containers"

printf '\nAll end-to-end checks passed.\n'
