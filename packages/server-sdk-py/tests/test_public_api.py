"""The names, call shapes and wire constants this SDK's consumers use, pinned.

Servers built on this SDK import the names below, and a skill-evaluation harness sends
``skills/list`` through the private request model in ``testing``. Each callable is pinned by
its parameters (name, kind and default, which is what a call site depends on), each constant by
its value, and each helper by what it returns and what it refuses, so a move or refactor
underneath cannot change a consumer's behaviour without failing here. Only the import lines
below may change when the package moves; ``test_golden_wire.py`` pins the same surfaces as a
host reads them.
"""

from __future__ import annotations

import importlib.metadata
import inspect
import logging
import re
import typing
from typing import Any

import pytest

import nimblebrain_server_sdk as sdk
from nimblebrain_server_sdk import ids, rows, testing

E = inspect.Parameter.empty
POS = inspect.Parameter.POSITIONAL_OR_KEYWORD
KW = inspect.Parameter.KEYWORD_ONLY

#: The names consumers import from the package root.
CONSUMED = {
    "ADDS",
    "CHANGES",
    "FACETS_EXTENSION_ID",
    "LIFECYCLE_EXTENSION_ID",
    "LifecycleEvent",
    "LifecycleExtension",
    "PREVIEW_CHARS",
    "READS",
    "RECORD_VIEW_META",
    "SkillDefinition",
    "add_lifecycle_extension",
    "add_platform_extension",
    "add_skills",
    "announce_resource_list_changed",
    "facet_count",
    "facet_meta",
    "listing_row",
    "new_prefixed_id",
    "new_ulid",
    "preview_text",
    "record_view_meta",
}

#: The names consumers import from the testing module. The skill-eval harness sends
#: ``skills/list`` with the private request model, so it is pinned with the public ones.
CONSUMED_TESTING = {
    "assert_bounded_rows",
    "served_facets",
    "served_skills",
    "ListSkillsParams",
    "_ANY",
    "_ListSkillsRequest",
}

ULID = re.compile(r"[0-9A-HJKMNP-TV-Z]{26}")


def _any(value: Any) -> Any:
    """``value`` with its type erased, to pass what a typed call site could not."""
    return value


def params(obj: Any) -> list[tuple[str, Any, Any]]:
    return [
        (p.name, p.kind, p.default)
        for p in inspect.signature(obj).parameters.values()
        if p.name != "self"
    ]


def test_consumed_names_are_exported() -> None:
    assert set(sdk.__all__) >= CONSUMED
    for name in sdk.__all__:
        assert hasattr(sdk, name), name
    for name in CONSUMED_TESTING:
        assert hasattr(testing, name), name


def test_all_is_unchanged() -> None:
    assert (
        set(sdk.__all__)
        == CONSUMED
        | {
            "FACET_LEVELS",
            "FacetLevel",
            "LIFECYCLE_EVENTS",
            "PlatformExtension",
            "SKILLS_EXTENSION_ID",
            "lifecycle_meta",
        }
        | HOST_RESOURCES
    )


#: The names the SDK exported before it took in the server helpers, unchanged by them.
HOST_RESOURCES = {
    "HOST_RESOURCES_CAPABILITY_KEY",
    "HOST_RESOURCES_LIST_METHOD",
    "HOST_RESOURCES_READ_METHOD",
    "INVALID_PARAMS",
    "RATE_LIMITED",
    "RESOURCE_NOT_FOUND",
    "RESPONSE_TOO_LARGE",
    "HostCapabilityMissing",
    "HostResources",
    "MCPServerSkillsExtension",
    "SkillsExtension",
    "host",
}


def test_wire_constants() -> None:
    assert sdk.FACETS_EXTENSION_ID == "ai.nimblebrain/facets"
    assert sdk.LIFECYCLE_EXTENSION_ID == "ai.nimblebrain/lifecycle"
    assert sdk.RECORD_VIEW_META == "ai.nimblebrain/view"
    assert sdk.SKILLS_EXTENSION_ID == "io.modelcontextprotocol/skills"
    assert sdk.PREVIEW_CHARS == 200
    assert rows.ELLIPSIS == "…"
    assert sdk.FACET_LEVELS == ("critical", "warning", "info")
    assert typing.get_args(sdk.FacetLevel) == sdk.FACET_LEVELS
    assert sdk.LIFECYCLE_EVENTS == ("ready", "removing")
    assert typing.get_args(sdk.LifecycleEvent) == sdk.LIFECYCLE_EVENTS
    assert ids.CROCKFORD_ALPHABET == "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    assert ids.ULID_LENGTH == 26


def test_host_resources_wire_constants() -> None:
    # The host matches these strings and codes exactly, so they are pinned as literals rather
    # than compared against the constants they come from.
    assert sdk.HOST_RESOURCES_CAPABILITY_KEY == "ai.nimblebrain/host-resources"
    assert sdk.HOST_RESOURCES_READ_METHOD == "ai.nimblebrain/resources/read"
    assert sdk.HOST_RESOURCES_LIST_METHOD == "ai.nimblebrain/resources/list"
    assert sdk.RESOURCE_NOT_FOUND == -32002
    assert sdk.RATE_LIMITED == -32004
    assert sdk.RESPONSE_TOO_LARGE == -32005
    assert sdk.INVALID_PARAMS == -32602


def test_version_matches_the_installed_distribution() -> None:
    assert sdk.__version__ == importlib.metadata.version("nimblebrain-server-sdk")


def test_annotations() -> None:
    def dump(a: Any) -> dict[str, Any]:
        return a.model_dump(by_alias=True, exclude_none=True)

    assert dump(sdk.READS) == {"readOnlyHint": True}
    assert dump(sdk.ADDS) == {"readOnlyHint": False, "destructiveHint": False}
    assert dump(sdk.CHANGES) == {"readOnlyHint": False, "destructiveHint": True}


@pytest.mark.parametrize(
    ("obj", "expected"),
    [
        (sdk.SkillDefinition, [("path", POS, E), ("files", POS, E), ("scheme", KW, "skill")]),
        (sdk.add_skills, [("mcp", POS, E), ("skills", POS, E)]),
        (
            sdk.add_platform_extension,
            [("mcp", POS, E), ("identifier", POS, E), ("settings", POS, None)],
        ),
        (sdk.PlatformExtension, [("identifier", POS, E), ("settings", POS, None)]),
        (sdk.add_lifecycle_extension, [("mcp", POS, E)]),
        (
            sdk.LifecycleExtension.handler,
            [
                ("event", POS, E),
                ("name", KW, None),
                ("title", KW, None),
                ("description", KW, None),
                ("annotations", KW, None),
                ("meta", KW, None),
            ],
        ),
        (sdk.announce_resource_list_changed, [("ctx", POS, None), ("tool", KW, None)]),
        (sdk.facet_meta, [("level", POS, E)]),
        (sdk.facet_count, [("count", POS, E)]),
        (sdk.lifecycle_meta, [("event", POS, E)]),
        (sdk.record_view_meta, [("view_uri", POS, E)]),
        (
            sdk.listing_row,
            [("record", POS, E), ("omit", KW, ()), ("preview", KW, None)],
        ),
        (sdk.preview_text, [("text", POS, E), ("chars", POS, 200)]),
        (sdk.new_ulid, []),
        (sdk.new_prefixed_id, [("prefix", POS, E)]),
        (testing.served_skills, [("mcp", POS, E), ("mode", POS, "auto")]),
        (testing.served_facets, [("mcp", POS, E), ("mode", POS, "auto")]),
        (
            testing.assert_bounded_rows,
            [("rows", POS, E), ("unbounded", KW, E), ("max_chars", KW, 1_000)],
        ),
    ],
)
def test_call_shapes(obj: Any, expected: list[tuple[str, Any, Any]]) -> None:
    assert params(obj) == expected


def test_the_extension_types_are_fastmcp_extensions() -> None:
    from fastmcp.server.extensions import ServerExtension

    assert issubclass(sdk.PlatformExtension, ServerExtension)
    assert issubclass(sdk.LifecycleExtension, sdk.PlatformExtension)


def test_meta_helpers() -> None:
    assert sdk.facet_meta("info") == {"ai.nimblebrain/facets": {"level": "info"}}
    assert sdk.lifecycle_meta("ready") == {"ai.nimblebrain/lifecycle": {"event": "ready"}}
    assert sdk.record_view_meta("ui://x/y") == {"ai.nimblebrain/view": "ui://x/y"}
    assert sdk.facet_count(0) == '{"count": 0}'
    assert sdk.facet_count(12) == '{"count": 12}'


@pytest.mark.parametrize(
    "call",
    [
        lambda: sdk.facet_meta(_any("urgent")),
        lambda: sdk.facet_count(-1),
        lambda: sdk.facet_count(True),
        lambda: sdk.facet_count(_any(1.0)),
        lambda: sdk.lifecycle_meta(_any("installed")),
        lambda: sdk.record_view_meta("https://x"),
        lambda: sdk.record_view_meta("ui://"),
        lambda: sdk.preview_text("abc", 0),
    ],
)
def test_helpers_refuse_with_value_error(call: Any) -> None:
    # Each case refuses with its own message; the pinned contract is that the refusal is a
    # ValueError.
    with pytest.raises(ValueError):  # noqa: PT011
        call()


def test_rows() -> None:
    assert sdk.preview_text("abc", 3) == "abc"
    assert sdk.preview_text("abcd", 3) == "ab…"
    assert sdk.preview_text("ab  cd", 4) == "ab…"
    assert sdk.preview_text("x" * 201) == "x" * 199 + "…"
    record = {"uri": "x://1", "body": "y" * 300, "notes": None, "secret": "s", "n": 1}
    assert sdk.listing_row(record, omit=("secret", "absent"), preview={"body": 10, "notes": 5}) == {
        "uri": "x://1",
        "n": 1,
        "body_preview": "yyyyyyyyy…",
        "notes_preview": None,
    }
    assert "body" in record
    assert "secret" in record
    with pytest.raises(TypeError):
        sdk.listing_row({"body": 1}, preview={"body": 5})


def test_a_ulid_encodes_its_millisecond_and_random_bits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ids, "_draw", lambda: 0x0123456789ABCDEF0123)
    minter = ids._Minter(clock=lambda: 1_700_000_000.123)
    assert [minter.mint() for _ in range(3)] == [
        "01HF7YAT3V04HMASW9NF6YY093",
        "01HF7YAT3V04HMASW9NF6YY094",
        "01HF7YAT3V04HMASW9NF6YY095",
    ]


def test_ids_are_prefix_underscore_ulid_and_increase() -> None:
    minted = [sdk.new_prefixed_id("th") for _ in range(500)]
    for value in minted:
        prefix, _, body = value.partition("_")
        assert prefix == "th"
        assert ULID.fullmatch(body), value
    assert minted == sorted(minted)
    assert len(set(minted)) == len(minted)
    assert ULID.fullmatch(sdk.new_ulid())


async def test_outside_a_request_an_announcement_does_nothing() -> None:
    assert await sdk.announce_resource_list_changed() is None


async def test_a_failed_announcement_is_logged_not_raised(caplog: pytest.LogCaptureFixture) -> None:
    class Broken:
        async def send_notification(self, notification: Any) -> None:
            raise RuntimeError("stream closed")

    with caplog.at_level(logging.WARNING):
        await sdk.announce_resource_list_changed(Broken(), tool="save_thing")  # ty: ignore[invalid-argument-type]

    (record,) = [
        r for r in caplog.records if r.getMessage() == "announce_resource_list_changed_failed"
    ]
    assert record.levelno == logging.WARNING
    assert record.__dict__["tool"] == "save_thing"
    assert record.exc_info is not None


def test_the_skill_eval_request_is_skills_list() -> None:
    request = testing._ListSkillsRequest(params=testing.ListSkillsParams())
    assert request.model_dump(by_alias=True, exclude_none=True) == {
        "method": "skills/list",
        "params": {},
    }
