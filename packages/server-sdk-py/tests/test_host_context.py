"""The host context reader, held to the published schema.

The fixtures are the TypeScript SDK's (``test/unit/plugins/server-sdk.test.ts``): a reader in any
language reads every context the schema accepts and reads every value it refuses as no context.
Each fixture carries the schema's verdict, and the schema in the repository confirms it.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from fastmcp import Client, Context, FastMCP
from jsonschema import Draft202012Validator

from nimblebrain_server_sdk import (
    HOST_CONTEXT_META_KEY,
    HostContext,
    host_context,
    is_host,
    read_host_context,
)
from nimblebrain_server_sdk.testing import Mode

SCHEMA_PATH = (
    Path(__file__).resolve().parents[3] / "schemas/host-context/v1/host-context.schema.json"
)

#: (value at ``params._meta["ai.nimblebrain/context"]``, whether the schema accepts it)
FIXTURES: list[tuple[Any, bool]] = [
    ({"principal": "host"}, True),
    (
        {"principal": "person", "workspaceId": "ws_1", "ownerId": "u", "conversationId": "conv_1"},
        True,
    ),
    ({"principal": "person", "workspaceId": "ws_1", "unknownField": {"anything": True}}, True),
    ({}, False),
    ({"workspaceId": "ws_1", "ownerId": "u"}, False),
    ({"principal": "admin", "workspaceId": "ws_1"}, False),
    ({"principal": "host", "workspaceId": ""}, False),
    ({"principal": "host", "ownerId": 7}, False),
    ({"principal": "person", "conversationId": None}, False),
    (
        {"principal": "person", "workspaceId": "ws_1", "ownerId": "u", "grant": "opaque.grant"},
        True,
    ),
    ({"principal": "person", "unattended": True}, True),
    ({"principal": "person", "unattended": False}, True),
    ({"principal": "person", "grant": ""}, False),
    ({"principal": "person", "grant": "g" * 4097}, False),
    ({"principal": "person", "grant": 7}, False),
    ({"principal": "person", "unattended": "true"}, False),
    ({"principal": "host", "workspaceId": "ws_1", "ownerId": "u", "runId": "run_1"}, True),
    ({"principal": "person", "runId": ""}, False),
    ({"principal": "person", "runId": 7}, False),
    ({"principal": "host", "workspaceId": "ws_1", "now": "2026-01-01T12:00:00Z"}, True),
    ({"principal": "person", "now": "2026-01-01T12:00:00.123Z"}, True),
    ({"principal": "person", "now": "2026-01-01T12:00:00.123456789Z"}, True),
    ({"principal": "person", "now": "2026-01-01T12:00:00.1234567890Z"}, False),
    ({"principal": "person", "now": "2026-01-01T12:00:00+00:00"}, False),
    ({"principal": "person", "now": "2026-01-01T12:00:00.000-10:00"}, False),
    ({"principal": "person", "now": "2026-01-01 12:00:00Z"}, False),
    ({"principal": "person", "now": "2026-01-01T12:00:00z"}, False),
    ({"principal": "person", "now": "2026-01-01"}, False),
    ({"principal": "person", "now": ""}, False),
    ({"principal": "person", "now": 1767268800000}, False),
    (None, False),
    ("host", False),
    (["host"], False),
]


def meta(context: Any) -> dict[str, Any]:
    return {HOST_CONTEXT_META_KEY: context}


@pytest.mark.parametrize(("value", "accepted"), FIXTURES)
def test_the_reader_accepts_exactly_what_the_schema_accepts(value: Any, accepted: bool) -> None:
    assert (read_host_context(meta(value)) is not None) == accepted


@pytest.mark.skipif(
    not SCHEMA_PATH.exists() and not os.environ.get("CI"), reason="outside the repository"
)
def test_each_fixture_carries_the_published_schemas_verdict() -> None:
    schema = json.loads(SCHEMA_PATH.read_text())
    assert schema["$id"] == (
        "https://schemas.nimblebrain.ai/host-context/v1/host-context.schema.json"
    )
    validator = Draft202012Validator(schema)
    assert [(value, validator.is_valid(value)) for value, _ in FIXTURES] == FIXTURES


@pytest.mark.parametrize(
    "now",
    [
        "2026-01-01T12:00:00Z\n",  # ECMA-262 `$` ends the string; Python's matches before `\n`
        "٢٠٢٦-01-01T12:00:00Z",  # ECMA-262 `\d` is an ASCII digit; Python's is any digit
    ],
)
def test_now_is_matched_as_the_schemas_ecma_pattern(now: str) -> None:
    assert read_host_context(meta({"principal": "person", "now": now})) is None


def test_the_reader_returns_the_schemas_fields_and_ignores_unknown_ones() -> None:
    assert read_host_context(meta(FIXTURES[1][0])) == HostContext(
        principal="person", workspace_id="ws_1", owner_id="u", conversation_id="conv_1"
    )
    assert read_host_context(meta(FIXTURES[2][0])) == HostContext(
        principal="person", workspace_id="ws_1"
    )
    assert read_host_context(
        meta({"principal": "person", "grant": "opaque.grant", "unattended": True})
    ) == HostContext(principal="person", grant="opaque.grant", unattended=True)
    assert read_host_context(
        meta({"principal": "host", "workspaceId": "ws_1", "runId": "run_1"})
    ) == HostContext(principal="host", workspace_id="ws_1", run_id="run_1")
    assert read_host_context(
        meta({"principal": "host", "now": "2026-01-01T12:00:00.5Z"})
    ) == HostContext(principal="host", now="2026-01-01T12:00:00.5Z")
    assert read_host_context({}) is None
    assert read_host_context(None) is None
    assert read_host_context({"ai.nimblebrain/scope": {"principal": "host"}}) is None


def test_a_call_that_names_no_principal_is_not_host() -> None:
    assert read_host_context(meta({"workspaceId": "ws_1", "ownerId": "u"})) is None
    assert not is_host(read_host_context(meta({"workspaceId": "ws_1", "ownerId": "u"})))
    assert not is_host(None)
    assert not is_host(HostContext(principal="person"))
    assert is_host(HostContext(principal="host"))


def test_the_grant_is_left_out_of_the_repr() -> None:
    context = HostContext(principal="person", grant="opaque.grant")
    assert "opaque.grant" not in repr(context)


mcp = FastMCP("context-probe")


@mcp.tool
async def probe(ctx: Context) -> dict[str, Any]:
    """Return the host context the call carries."""
    context = host_context(ctx)
    if context is None:
        return {"context": None}
    return {"principal": context.principal, "workspace": context.workspace_id}


@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_a_tool_reads_the_context_its_call_carries(mode: Mode) -> None:
    async with Client(mcp, mode=mode) as client:
        stamped = await client.call_tool(
            "probe", {}, meta=meta({"principal": "person", "workspaceId": "ws_1"})
        )
        bare = await client.call_tool("probe", {})
        malformed = await client.call_tool("probe", {}, meta=meta({"principal": "admin"}))
    assert stamped.structured_content == {"principal": "person", "workspace": "ws_1"}
    assert bare.structured_content == {"context": None}
    assert malformed.structured_content == {"context": None}


def test_outside_a_request_there_is_no_context() -> None:
    assert host_context(Context(mcp)) is None
