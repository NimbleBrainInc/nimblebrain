"""The outbox as an MCP resource, on a real FastMCP server.

Registered on the real thing rather than a stub because the parts worth testing
are FastMCP's: that an RFC 6570 template with only query parameters is a legal
resource, that a bare read matches it, and that absent parameters fall to the
handler's defaults. A stub would agree with whatever this library assumed.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastmcp import Client, FastMCP
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from nimblebrain_server_sdk.db import SecurityContext, secured_session
from nimblebrain_server_sdk.outbox import emit, register_outbox
from nimblebrain_server_sdk.outbox.fastmcp import _SPECIAL_SCHEMES, _check_resource
from tests.outbox.conftest import make_ctx
from tests.outbox.test_outbox import envelope

#: URIs an adopter may legitimately declare — outbox names, which is all an
#: outbox URI is. An earlier version of this tuple held a port, a percent escape
#: and an opaque ``urn:``, none of which any adopter asked for; they were here to
#: justify a character set, and the character set was here to admit them.
VALID_RESOURCES = (
    "acme://notifications",
    "acme://inbox",
    "acme://domain-events",
    "acme://a/b",
    "acme://mail.bounces/hard",
    "a1+b-c.d://x",
)

WS_A = make_ctx("ws_a")
WS_B = make_ctx("ws_b")


def build(
    engine: AsyncEngine,
    ctx: SecurityContext = WS_A,
    resource: str = "acme://notifications",
    **kwargs: Any,
) -> FastMCP:
    """A server with the outbox registered — the adopter's three arguments.

    ``resource`` is the manifest's declared URI, passed whole. Every read below
    addresses the same string, which is what makes it evidence that taking the
    URI rather than building it changed where the value comes from and nothing
    about what is served.
    """
    server: FastMCP = FastMCP("outbox-under-test")
    register_outbox(
        server,
        resource,
        lambda identity: secured_session(engine, identity),
        lambda: ctx,
        **kwargs,
    )
    return server


async def resource_read(server: FastMCP, uri: str) -> dict[str, Any]:
    async with Client(server) as client:
        contents = await client.read_resource(uri)
    return json.loads(contents[0].text)


async def test_the_template_is_registered_with_its_query_parameters(engine) -> None:
    async with Client(build(engine)) as client:
        templates = await client.list_resource_templates()
    (template,) = [t for t in templates if t.name == "notifications"]
    assert template.uri_template == "acme://notifications{?cursor,maxEvents,maxAgeMs}"
    assert template.mime_type == "application/json"


async def test_a_bare_read_bootstraps(engine) -> None:
    """No query string at all: every parameter falls to its Python default."""
    result = await resource_read(build(engine), "acme://notifications")
    assert result == {
        "events": [],
        "cursor": result["cursor"],
        "truncated": False,
        "hasMore": False,
    }


async def test_the_query_parameters_reach_the_read(engine) -> None:
    server = build(engine)
    start = await resource_read(server, "acme://notifications")
    for index in range(3):
        async with secured_session(engine, WS_A) as conn:
            await emit(conn, WS_A, envelope(f"evt_{index}"))

    page = await resource_read(server, f"acme://notifications?cursor={start['cursor']}&maxEvents=2")
    assert [event["eventId"] for event in page["events"]] == ["evt_0", "evt_1"]
    assert page["hasMore"] is True


async def test_a_malformed_parameter_falls_back_rather_than_failing_the_poll(engine) -> None:
    """A bug in the caller must not cost a workspace its notifications."""
    result = await resource_read(build(engine), "acme://notifications?maxEvents=lots")
    assert result["events"] == []


async def test_the_identity_function_is_what_scopes_the_read(engine) -> None:
    """The library owns no identity: swap the function and the answer changes."""
    async with secured_session(engine, WS_A) as conn:
        await emit(conn, WS_A, envelope("evt_a"))

    as_a = build(engine, WS_A)
    start = await resource_read(as_a, "acme://notifications")
    async with secured_session(engine, WS_A) as conn:
        await emit(conn, WS_A, envelope("evt_after"))

    assert [
        e["eventId"]
        for e in (await resource_read(as_a, f"acme://notifications?cursor={start['cursor']}"))[
            "events"
        ]
    ] == ["evt_after"]
    assert (
        await resource_read(build(engine, WS_B), f"acme://notifications?cursor={start['cursor']}")
    )["events"] == []


async def test_the_hook_emits_into_the_transaction_that_answers_the_poll(engine) -> None:
    """The poll as the server's tick: what the hook records, the poll returns.

    Past the bootstrap read, which starts from now and carries no history by
    design — including anything the hook recorded on the way in.
    """

    async def tick(ctx: SecurityContext, conn: AsyncConnection) -> int:
        await emit(conn, ctx, envelope("evt_ticked"))
        return 15_000

    start = await resource_read(build(engine), "acme://notifications")
    result = await resource_read(
        build(engine, on_read=tick), f"acme://notifications?cursor={start['cursor']}"
    )
    assert [event["eventId"] for event in result["events"]] == ["evt_ticked"]
    assert result["nextPollMs"] == 15_000

    # And the cursor it answered with does not hand them over a second time.
    following = await resource_read(
        build(engine), f"acme://notifications?cursor={result['cursor']}"
    )
    assert following["events"] == []


async def test_a_synchronous_hook_is_accepted(engine) -> None:
    server = build(engine, on_read=lambda ctx, conn: 30_000)
    assert (await resource_read(server, "acme://notifications"))["nextPollMs"] == 30_000


# --------------------------------------------------------------------------- #
# The URI is the server's own.                                                 #
# --------------------------------------------------------------------------- #


async def test_an_outbox_that_is_not_at_notifications_is_served(engine) -> None:
    """The declared URI is taken whole, so its path is the server's to choose.

    A library that built ``<prefix>://notifications`` could not serve a server
    whose manifest legitimately declares something else, and the host — which
    reads the declaration as an opaque string — would poll a URI nothing
    answered.
    """
    server = build(engine, resource="acme://inbox")
    async with Client(server) as client:
        templates = await client.list_resource_templates()
    assert any(t.uri_template == "acme://inbox{?cursor,maxEvents,maxAgeMs}" for t in templates)
    assert (await resource_read(server, "acme://inbox"))["events"] == []


REFUSED = [
    # not a URI at all
    "notifications",
    "://notifications",
    "acme:/notifications",
    "acme:notifications",
    # a scheme a parser rewrites, or one that is not a scheme
    "9lives://x",
    "acme_x://notifications",
    "ACME://x",
    "AcMe://notifications",
    # the template's own delimiters
    "acme://notifications?since=1",
    "acme://notifications#top",
    "ac?me://notifications",
    # characters a name has no use for
    "acme://a[b",
    "acme://a|b",
    "acme://a\\b",
    "acme://a\x00b",
    "acme://note ifications",
    "acme://notifications{",
    "acme://[::1]/x",
    # userinfo, ports, and the empty forms of each
    "acme://a@b",
    "acme://@b",
    "acme://u:p@h/x",
    "acme://events:inbound",
    "acme://a:",
    "acme://:8080",
    "acme://a:0080",
    "acme://host.example:8080/a/b",
    # percent escapes and dot segments, however they are spelled
    "acme://a/%2e",
    "acme://a/%2E",
    "acme://a.b_c/d~e%20f",
    "acme://a/.",
    "acme://a/../b",
    # empty, trailing and doubled separators
    "acme://",
    "acme://notifications/",
    "acme://a//b",
    "acme://-a",
    "acme://a-",
]


@pytest.mark.parametrize("resource", REFUSED)
def test_a_resource_that_is_not_a_name_is_refused(engine, resource: str) -> None:
    """One rule, so one message: an outbox URI is a name or it is nothing.

    Each of these took its own rule and its own review round back when the guard
    admitted the RFC 3986 grammar and then subtracted what normalises. They are
    kept as a list because they are the record of what the wide set let through,
    but they no longer have separate reasons — a name simply has no port, no
    percent escape, no userinfo and no capital to go wrong with.
    """
    with pytest.raises(ValueError, match="not a name this module can serve"):
        build(engine, resource=resource)


@pytest.mark.parametrize("resource", sorted(_SPECIAL_SCHEMES))
def test_a_scheme_a_parser_reinterprets_is_refused(engine, resource: str) -> None:
    """The one thing the pattern cannot express: ``http`` is a well-formed name.

    A URL parser does not carry these schemes, it reinterprets them, so
    ``http://x`` is read back as ``http://x/``. Refused on the same argument the
    pattern rests on — an outbox is addressed by the server's own name, and a
    scheme the world already owns is not that.
    """
    with pytest.raises(ValueError, match="reinterprets rather than carries"):
        build(engine, resource=f"{resource}://x")


@pytest.mark.parametrize("resource", VALID_RESOURCES)
async def test_every_uri_this_file_calls_valid_actually_serves(engine, resource: str) -> None:
    """The list of legitimate URIs, checked against a server instead of asserted.

    ``VALID_RESOURCES`` is what the sweep measures itself against: a guard change
    is judged safe when it still admits them. Nothing checked the claim
    underneath, so ``ACME://x`` sat in the list for four rounds — admitted,
    registered, and answering no read, because the resource is registered under
    the literal string while a read is resolved through a parser that lowercases
    the scheme. Admitting a URI is the cheap half; this reads each one.
    """
    server = build(engine, resource=resource)
    assert (await resource_read(server, resource))["events"] == []
    assert (await resource_read(server, f"{resource}?maxEvents=2"))["events"] == []


def test_the_swept_uris_the_guard_admits_all_resolve_to_themselves() -> None:
    """Whatever the guard admits out of a broad input space resolves unchanged.

    The guard is a name pattern, so nearly everything below is refused, and that
    is the point — this asserts the survivors. FastMCP registers a resource under
    the literal string and resolves a read through ``pydantic.AnyUrl``, so a URI
    that normalises lists at one address and answers at another. Every admitted
    URI is compared to its resolved form exactly, capitals included.

    The alphabet is every printable ASCII character rather than the pattern's own
    class, and the schemes include the ones a parser reinterprets. Deriving a
    sweep from the thing it polices is how a set that shrank stopped being swept;
    this space is fixed and does not move when the pattern does.

    It is a sample, not a proof. What makes the guard defensible is not this
    sweep's size but the pattern's narrowness — a name has no percent escape, no
    userinfo, no port and no capital to normalise.
    """
    from pydantic import AnyUrl

    placements = [
        "{1}://{0}b",
        "{1}://a{0}b",
        "{1}://a{0}",
        "{1}://{0}",
        "{1}://a{0}/b",
        "{1}://a/{0}b",
        "{1}://a/b{0}d",
        "{1}://a/b{0}",
        "{1}://a/{0}",
        "{1}:{0}b",
        "{1}:a{0}b",
        "{1}://a:8{0}0",
        "{1}://a/%2{0}",
    ]
    schemes = ["acme", "urn", "x", "a1", "s+t", "s-t", "s.t", "ACME"] + sorted(_SPECIAL_SCHEMES)  # noqa: RUF005
    alphabet = [chr(code) for code in range(32, 127)]

    def resolves_to_itself(candidate: str) -> bool:
        try:
            return str(AnyUrl(candidate)) == candidate
        except ValueError:
            return False  # a refusal is a failure to resolve, not a test error

    swept = [t.format(c, s) for s in schemes for c in alphabet for t in placements]
    swept += list(VALID_RESOURCES)

    admitted = 0
    for candidate in swept:
        try:
            _check_resource(candidate)
        except ValueError:
            continue
        admitted += 1
        assert resolves_to_itself(candidate), (
            f"{candidate!r} is admitted but does not resolve to itself; "
            "it would list at one address and read at another"
        )
    assert admitted >= len(VALID_RESOURCES), "the sweep admitted nothing; the guard is inert"
