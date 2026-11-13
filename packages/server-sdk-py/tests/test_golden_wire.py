"""What a host reads from a server built on this library, pinned byte for byte on both eras.

A probe server uses every surface the library puts on the wire: a platform extension with
settings, a facet, both lifecycle handlers, the three annotations, a record view, a skill with a
reference file, and a write that announces. Each era's answers are reduced to the fields this
library decides (FastMCP's own keys are dropped) and compared with ``golden/wire.json``.

Hosts and the tests of every server built on this SDK depend on these bytes: the extension identifiers, the
``_meta`` keys and their shapes, the facet body, the skill digests, and that a write announces
in its own response and a read does not. The file is frozen output with no regenerate switch;
a change to it is a change to the protocol a host reads, and is reviewed as one.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx2
from fastmcp import Context, FastMCP

import nimblebrain_server_sdk as sdk

GOLDEN = Path(__file__).parent / "golden" / "wire.json"

LEGACY = "2025-11-25"
MODERN = "2026-07-28"
HEADERS = {"accept": "application/json, text/event-stream", "content-type": "application/json"}
CLIENT_INFO = {"name": "probe", "version": "0"}

SKILL_MD = (
    "---\nname: probe\ndescription: Works the probe's records.\n"
    "metadata:\n  nimblebrain:\n    loading-strategy: dynamic\n    tool-affinity: [read_thing]\n"
    "---\n\nRead before you write.\n"
)


def _probe() -> FastMCP:
    mcp = FastMCP("probe")
    sdk.add_platform_extension(mcp, "ai.example/probe", {"version": 1})
    sdk.add_platform_extension(mcp, sdk.FACETS_EXTENSION_ID)
    sdk.add_skills(
        mcp,
        [sdk.SkillDefinition("probe", {"SKILL.md": SKILL_MD, "references/more.md": "More.\n"})],
    )
    lifecycle = sdk.add_lifecycle_extension(mcp)

    @lifecycle.handler("ready", annotations=sdk.CHANGES)
    async def scope_ready(reason: str | None = None) -> str:
        return f"ready: {reason}"

    @lifecycle.handler("removing", annotations=sdk.CHANGES, meta={"ui": {"visibility": ["app"]}})
    async def scope_removing() -> str:
        return "removing"

    @mcp.tool(annotations=sdk.READS)
    async def read_thing(ctx: Context) -> str:
        return "read"

    @mcp.tool(annotations=sdk.ADDS)
    async def add_thing(ctx: Context) -> str:
        await sdk.announce_resource_list_changed(ctx, tool="add_thing")
        return "added"

    @mcp.tool(annotations=sdk.CHANGES)
    async def change_thing() -> str:
        await sdk.announce_resource_list_changed()
        return "changed"

    @mcp.resource(
        "probe://facets/stuck",
        name="probe-stuck",
        title="Things stuck",
        mime_type="application/json",
        meta=sdk.facet_meta("critical"),
    )
    async def probe_stuck() -> str:
        return sdk.facet_count(3)

    @mcp.resource(
        "probe://things/{thing_id}",
        name="thing",
        mime_type="application/json",
        meta=sdk.record_view_meta("ui://probe/things"),
    )
    async def thing(thing_id: str) -> str:
        return json.dumps({"id": thing_id})

    return mcp


def _messages(response: httpx2.Response) -> list[dict[str, Any]]:
    if response.headers["content-type"].startswith("application/json"):
        return [response.json()]
    return [
        json.loads(line.removeprefix("data:"))
        for line in response.text.splitlines()
        if line.startswith("data:")
    ]


class _Peer:
    """One era's client over streamable HTTP, speaking raw JSON-RPC."""

    def __init__(self, http: httpx2.AsyncClient, era: str) -> None:
        self.http = http
        self.era = era
        self.headers: dict[str, str] = {**HEADERS}
        self.next_id = 1

    async def open(self) -> dict[str, Any]:
        if self.era == MODERN:
            return await self.request("server/discover")
        result = await self.request(
            "initialize",
            {"protocolVersion": LEGACY, "capabilities": {}, "clientInfo": CLIENT_INFO},
        )
        await self.http.post(
            "/mcp",
            headers=self.headers,
            json={"jsonrpc": "2.0", "method": "notifications/initialized"},
        )
        return result

    async def exchange(self, method: str, params: dict[str, Any] | None = None) -> list[Any]:
        params = dict(params or {})
        headers = dict(self.headers)
        if self.era == MODERN:
            params["_meta"] = {
                "io.modelcontextprotocol/protocolVersion": MODERN,
                "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
                "io.modelcontextprotocol/clientCapabilities": {},
            }
            headers |= {"mcp-protocol-version": MODERN, "mcp-method": method}
            # 2026-07-28 routes a call on the Mcp-Name header, which must match the body.
            if method == "tools/call":
                headers["mcp-name"] = params["name"]
            elif method == "resources/read":
                headers["mcp-name"] = params["uri"]
        self.next_id += 1
        body = {"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params}
        response = await self.http.post("/mcp", headers=headers, json=body)
        if method == "initialize":
            self.headers |= {
                "mcp-session-id": response.headers["mcp-session-id"],
                "mcp-protocol-version": LEGACY,
            }
        return _messages(response)

    async def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        (*_, last) = await self.exchange(method, params)
        assert "result" in last, (self.era, method, last)
        return last["result"]


def _own(meta: dict[str, Any] | None) -> dict[str, Any]:
    """``_meta`` without FastMCP's own key."""
    return {k: v for k, v in (meta or {}).items() if k != "fastmcp"}


async def _extensions_of_a_bare_server() -> set[str]:
    bare = FastMCP("bare")
    app = bare.http_app()
    async with (
        app.router.lifespan_context(app),
        httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://p") as http,
    ):
        discovered = await _Peer(http, MODERN).open()
    return set(discovered["capabilities"].get("extensions") or {})


async def _wire(era: str) -> dict[str, Any]:
    framework = await _extensions_of_a_bare_server()
    app = _probe().http_app()
    async with (
        app.router.lifespan_context(app),
        httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://p") as http,
    ):
        peer = _Peer(http, era)
        opened = await peer.open()
        extensions = opened["capabilities"].get("extensions")
        tools = (await peer.request("tools/list"))["tools"]
        resources = (await peer.request("resources/list"))["resources"]
        templates = (await peer.request("resources/templates/list"))["resourceTemplates"]
        facet = await peer.request("resources/read", {"uri": "probe://facets/stuck"})
        skills = (await peer.request("skills/list"))["skills"]
        reference = await peer.request(
            "resources/read", {"uri": "skill://probe/references/more.md"}
        )
        calls = {}
        for name, arguments in [
            ("read_thing", {}),
            ("add_thing", {}),
            ("change_thing", {}),
            ("scope_ready", {"reason": "install"}),
            ("scope_ready", {}),
            ("scope_removing", {}),
        ]:
            messages = await peer.exchange("tools/call", {"name": name, "arguments": arguments})
            (result,) = [m["result"] for m in messages if "result" in m]
            calls[f"{name} {json.dumps(arguments, sort_keys=True)}"] = {
                "notifications": [m["method"] for m in messages if "method" in m],
                "text": [c["text"] for c in result["content"]],
            }
    return {
        "extensions": None
        if extensions is None
        else {k: v for k, v in extensions.items() if k not in framework},
        "tools": {
            t["name"]: {
                "annotations": t.get("annotations"),
                "_meta": _own(t.get("_meta")),
                "required": t["inputSchema"].get("required", []),
            }
            for t in tools
        },
        "resources": [
            {
                "uri": r["uri"],
                "name": r["name"],
                "title": r.get("title"),
                "mimeType": r.get("mimeType"),
                "_meta": _own(r.get("_meta")),
            }
            for r in resources
        ],
        "templates": [
            {"uriTemplate": t["uriTemplate"], "name": t["name"], "_meta": _own(t.get("_meta"))}
            for t in templates
        ],
        "facet_read": [
            {"mimeType": c.get("mimeType"), "text": c["text"]} for c in facet["contents"]
        ],
        "skills": skills,
        "skill_reference_read": [
            {"uri": c["uri"], "mimeType": c.get("mimeType"), "text": c["text"]}
            for c in reference["contents"]
        ],
        "calls": calls,
    }


async def test_the_wire_matches_the_golden_file_on_both_eras():
    got = {era: await _wire(era) for era in (LEGACY, MODERN)}

    rendered = json.dumps(got, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    assert rendered == GOLDEN.read_text(encoding="utf-8")
