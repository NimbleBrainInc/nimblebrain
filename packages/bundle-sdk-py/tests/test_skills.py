"""SEP-2640 skills extension: construction-time validation and the wire, end to end.

The wire tests connect a real client in-process to a FastMCP server and to an
`mcp` SDK `MCPServer`, call `skills/list` / `skills/get`, and read every listed
file back through `resources/read` to check its bytes against the digest.
"""

from __future__ import annotations

import base64
import hashlib
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

import mcp_types
import pytest
from fastmcp import Client as FastMCPClient
from fastmcp import FastMCP
from mcp.client import Client
from mcp.server.mcpserver import MCPServer
from mcp.shared.exceptions import MCPError
from pydantic import TypeAdapter

from nimblebrain_bundle_sdk.skills import (
    SKILLS_EXTENSION_ID,
    GetSkillParams,
    ListSkillsParams,
    MCPServerSkillsExtension,
    SkillDefinition,
    SkillsCatalog,
    SkillsExtension,
)

FIXTURE = Path(__file__).parent / "fixtures" / "skills" / "pdf-processing"
SKILL_MD = "---\nname: {name}\ndescription: Does a thing.\n---\n\nBody.\n"


def generated_refunds() -> SkillDefinition:
    """A skill whose files are built in memory, under a prefixed skill path."""
    return SkillDefinition(
        "acme/billing/refunds",
        {
            "SKILL.md": SKILL_MD.format(name="refunds"),
            "examples/email.md": "Dear customer,\r\n",
            "assets/logo.bin": b"\x89PNG\x00\xff",
        },
    )


def sha256(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------
# Construction
# --------------------------------------------------------------------------


def test_directory_skill_lists_every_file_with_digest_and_size() -> None:
    skill = SkillDefinition.from_directory(FIXTURE)
    entry = skill.entry()

    assert entry["uri"] == "skill://pdf-processing/SKILL.md"
    on_disk = {
        f"skill://pdf-processing/{p.relative_to(FIXTURE).as_posix()}": p.read_bytes()
        for p in FIXTURE.rglob("*")
        if p.is_file()
    }
    assert {r["uri"] for r in entry["resources"]} == set(on_disk)
    for resource in entry["resources"]:
        data = on_disk[resource["uri"]]
        assert resource["digest"] == sha256(data)
        assert resource["size"] == len(data)


def test_frontmatter_is_verbatim_and_yaml_1_2_scalars_stay_strings() -> None:
    skill = SkillDefinition.from_directory(FIXTURE)

    # `released: 2026-01-01` is a date to YAML 1.1 but a string to the YAML
    # 1.2 parser a host compares with; the entry must match the host.
    assert skill.frontmatter == {
        "name": "pdf-processing",
        "description": "Extract, fill, and assemble PDF documents.",
        "license": "MIT",
        "metadata": {"version": "2.1.0", "released": "2026-01-01"},
    }
    flags = SkillDefinition(
        "flags",
        {"SKILL.md": "---\nname: flags\ndescription: d\nmetadata:\n  on: yes\n  real: true\n---\n"},
    )
    assert flags.frontmatter["metadata"] == {"on": "yes", "real": True}


def test_frontmatter_numbers_follow_yaml_1_2() -> None:
    values = "\n".join(
        f"  {k}: {v}"
        for k, v in [
            ("clock", "1:30"),
            ("underscored", "1_000"),
            ("binary", "0b101"),
            ("leading_zero", "017"),
            ("octal", "0o17"),
            ("hex", "0x1F"),
            ("negative", "-5"),
            ("exponent", "1e3"),
            ("decimal", "2.5"),
        ]
    )
    skill = SkillDefinition(
        "nums", {"SKILL.md": f"---\nname: nums\ndescription: d\nmetadata:\n{values}\n---\n"}
    )
    assert skill.frontmatter["metadata"] == {
        "clock": "1:30",
        "underscored": "1_000",
        "binary": "0b101",
        "leading_zero": 17,
        "octal": 15,
        "hex": 31,
        "negative": -5,
        "exponent": 1000.0,
        "decimal": 2.5,
    }


def test_generated_skill_under_a_prefixed_path() -> None:
    skill = generated_refunds()
    entry = skill.entry()

    assert entry["uri"] == "skill://acme/billing/refunds/SKILL.md"
    assert entry["frontmatter"]["name"] == "refunds"
    by_uri = {r["uri"]: r for r in entry["resources"]}
    assert by_uri["skill://acme/billing/refunds/examples/email.md"] == {
        "uri": "skill://acme/billing/refunds/examples/email.md",
        "digest": sha256(b"Dear customer,\r\n"),
        "size": 16,
    }
    assert by_uri["skill://acme/billing/refunds/assets/logo.bin"]["size"] == 6


def test_name_must_equal_last_path_segment() -> None:
    with pytest.raises(ValueError, match="must equal the last segment"):
        SkillDefinition("tasks", {"SKILL.md": SKILL_MD.format(name="task-guide")})


def test_directory_name_is_the_default_skill_path(tmp_path: Path) -> None:
    skill_dir = tmp_path / "wrong-dir"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(SKILL_MD.format(name="tasks"))

    with pytest.raises(ValueError, match="must equal the last segment"):
        SkillDefinition.from_directory(skill_dir)
    assert SkillDefinition.from_directory(skill_dir, path="tasks").uri == "skill://tasks/SKILL.md"


@pytest.mark.parametrize(
    ("files", "message"),
    [
        ({"README.md": "x"}, "must include SKILL.md"),
        ({"SKILL.md": "# no frontmatter\n"}, "must begin with"),
        ({"SKILL.md": "---\nname: Bad_Name\ndescription: d\n---\n"}, "lowercase"),
        ({"SKILL.md": "---\nname: x\n---\n"}, "description"),
        ({"SKILL.md": "---\nname: x\ndescription: d\nn: .nan\n---\n"}, "JSON"),
        ({"SKILL.md": SKILL_MD.format(name="x"), "../escape.md": "x"}, "invalid file path"),
        ({"SKILL.md": SKILL_MD.format(name="x"), "refs/a b.md": "x"}, "rename the file"),
        ({"SKILL.md": b"\xff\xfe"}, "UTF-8"),
    ],
)
def test_invalid_skills_fail_at_construction(files: dict[str, Any], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        SkillDefinition("x", files)


def test_catalog_rejects_duplicate_skill_uris() -> None:
    with pytest.raises(ValueError, match="two skills"):
        SkillsCatalog([FIXTURE, SkillDefinition.from_directory(FIXTURE)])


def test_oversized_skill_warns() -> None:
    files: dict[str, str | bytes] = {"SKILL.md": SKILL_MD.format(name="big")}
    files.update({f"f{i}.txt": "x" for i in range(512)})
    with pytest.warns(UserWarning, match="SEP-2640 limits"):
        SkillDefinition("big", files)


# --------------------------------------------------------------------------
# Wire
# --------------------------------------------------------------------------


class _ListSkillsRequest(mcp_types.Request[ListSkillsParams, Literal["skills/list"]]):
    method: Literal["skills/list"] = "skills/list"
    params: ListSkillsParams


class _GetSkillRequest(mcp_types.Request[GetSkillParams, Literal["skills/get"]]):
    method: Literal["skills/get"] = "skills/get"
    params: GetSkillParams


_ANY = TypeAdapter(dict[str, Any])


class Wire:
    """The calls a host makes, over whichever client the server needs."""

    def __init__(self, session: Any, read: Callable[[str], Awaitable[Any]], caps: Any) -> None:
        self.session = session
        self.read = read
        self.capabilities = caps

    async def list(self, cursor: str | None = None) -> dict[str, Any]:
        params = ListSkillsParams(cursor=cursor)
        return await self.session.send_request(_ListSkillsRequest(params=params), _ANY)

    async def get(self, uri: str) -> dict[str, Any]:
        params = GetSkillParams(uri=uri)
        return await self.session.send_request(_GetSkillRequest(params=params), _ANY)

    async def read_bytes(self, uri: str) -> bytes:
        (content,) = (await self.read(uri)).contents
        text = getattr(content, "text", None)
        return text.encode("utf-8") if text is not None else base64.b64decode(content.blob)


def _skills() -> list[Any]:
    return [FIXTURE, generated_refunds()]


@asynccontextmanager
async def fastmcp_wire() -> AsyncIterator[Wire]:
    server = FastMCP("skills-test")
    server.add_extension(SkillsExtension(_skills()))
    async with FastMCPClient(server) as client:
        caps = client.server_capabilities
        yield Wire(client.session, client.session.read_resource, caps)


@asynccontextmanager
async def mcpserver_wire(mode: str = "auto") -> AsyncIterator[Wire]:
    server = MCPServer("skills-test", extensions=[MCPServerSkillsExtension(_skills())])
    async with Client(server, mode=mode) as client:
        caps = client.server_capabilities
        yield Wire(client.session, client.session.read_resource, caps)


WIRES = {
    "fastmcp": fastmcp_wire,
    "mcpserver": mcpserver_wire,
    "mcpserver-legacy": lambda: mcpserver_wire("legacy"),
}


@pytest.fixture(params=list(WIRES))
def wire_name(request: pytest.FixtureRequest) -> str:
    return request.param


async def test_declares_extension_and_resources(wire_name: str) -> None:
    async with WIRES[wire_name]() as wire:
        assert wire.capabilities.resources is not None
        if wire_name == "mcpserver-legacy":
            # The 2025-11-25 schema has no `capabilities.extensions`, so the mcp
            # SDK leaves it off a handshake-era `initialize` result. The
            # methods still answer (the tests below run on this wire too).
            assert wire.capabilities.extensions is None
        else:
            assert wire.capabilities.extensions[SKILLS_EXTENSION_ID] == {}


async def test_list_returns_every_skill_and_reads_match_digests(wire_name: str) -> None:
    async with WIRES[wire_name]() as wire:
        result = await wire.list()
        skills = {s["uri"]: s for s in result["skills"]}
        assert set(skills) == {
            "skill://acme/billing/refunds/SKILL.md",
            "skill://pdf-processing/SKILL.md",
        }
        assert "nextCursor" not in result
        for skill in skills.values():
            for resource in skill["resources"]:
                data = await wire.read_bytes(resource["uri"])
                assert sha256(data) == resource["digest"], resource["uri"]
                assert len(data) == resource["size"], resource["uri"]


async def test_get_returns_the_list_entry(wire_name: str) -> None:
    async with WIRES[wire_name]() as wire:
        listed = {s["uri"]: s for s in (await wire.list())["skills"]}
        got = await wire.get("skill://pdf-processing/SKILL.md")
        assert got["skill"] == listed["skill://pdf-processing/SKILL.md"]
        assert "nextCursor" not in got


async def test_get_unknown_uri_is_invalid_params(wire_name: str) -> None:
    async with WIRES[wire_name]() as wire:
        for uri in ("skill://nope/SKILL.md", "skill://pdf-processing/references/FORMS.md"):
            with pytest.raises(MCPError) as excinfo:
                await wire.get(uri)
            assert excinfo.value.code == mcp_types.INVALID_PARAMS


async def test_unknown_cursor_is_invalid_params(wire_name: str) -> None:
    async with WIRES[wire_name]() as wire:
        with pytest.raises(MCPError) as excinfo:
            await wire.list(cursor="bogus")
        assert excinfo.value.code == mcp_types.INVALID_PARAMS


@pytest.mark.parametrize("wire_name", ["fastmcp", "mcpserver"])
async def test_cache_attributes_only_on_modern_protocol(wire_name: str) -> None:
    async with WIRES[wire_name]() as modern:
        result = await modern.list()
        assert (result["ttlMs"], result["cacheScope"]) == (0, "private")
        got = await modern.get("skill://pdf-processing/SKILL.md")
        assert (got["ttlMs"], got["cacheScope"]) == (0, "private")
    async with mcpserver_wire("legacy") as legacy:
        result = await legacy.list()
        assert "ttlMs" not in result and "cacheScope" not in result


async def test_skill_md_resource_metadata_comes_from_frontmatter() -> None:
    server = FastMCP("skills-test")
    server.add_extension(SkillsExtension([FIXTURE]))
    async with FastMCPClient(server) as client:
        resources = {str(r.uri): r for r in await client.list_resources()}
    skill_md = resources["skill://pdf-processing/SKILL.md"]
    assert skill_md.name == "pdf-processing"
    assert skill_md.description == "Extract, fill, and assemble PDF documents."
    assert skill_md.mime_type == "text/markdown"
    assert resources["skill://pdf-processing/scripts/extract.py"].mime_type == "text/x-python"


def test_fastmcp_extension_must_be_bound_before_its_methods() -> None:
    with pytest.raises(RuntimeError, match="not bound"):
        SkillsExtension([FIXTURE]).methods()


async def test_fastmcp_start_fails_when_a_skill_uri_is_registered_again() -> None:
    server = FastMCP("skills-test")
    server.add_extension(SkillsExtension([FIXTURE]))

    @server.resource("skill://pdf-processing/SKILL.md")
    def hand_registered() -> str:
        return "an older SKILL.md"

    with pytest.raises(RuntimeError, match="another resource"):
        async with FastMCPClient(server):
            pass
