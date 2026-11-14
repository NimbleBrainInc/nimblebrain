"""The FastMCP adapter: the outbox served as one resource.

Ten lines in a server's ``server.py`` and its outbox is readable over the
ordinary MCP path — ``resources/read`` on the URI the server declared, plus
``{?cursor,maxEvents,maxAgeMs}``, which every MCP revision and every transport
already supports. No extension method, no SDK on either side, and nothing here
that would have to change when the Triggers and Events extension ships its
``events/poll``.

**The URI is the server's, not this library's.** It is taken whole rather than
built from a prefix, because the manifest is where it is declared and the host
reads that declaration as an opaque string — so a server whose outbox is
``acme://inbox`` is served exactly as one whose outbox is ``acme://notifications``.
Constructing it here would make the value live in two places, and the copy in
code would be the one nobody checks against the manifest.

**This module imports nothing from FastMCP.** It takes the server object as an
argument and calls two methods on it, so the core stays free of an MCP
dependency without any lazy-import machinery, and a server on a FastMCP version
this library has never seen keeps working.

It owns neither a session nor an identity function; both are injected. That is
the point rather than a convenience: a server's outbox is then authorized by
the same function as its tools, so a server that gets identity wrong gets it
wrong in one visible place instead of two — there is no second identity path to
keep in step with the first.
"""

from __future__ import annotations

import inspect
import json
import re
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from typing import TYPE_CHECKING, Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncConnection

from nimblebrain_server_sdk.db import SecurityContext

from .core import DEFAULT_MAX_EVENTS, read

if TYPE_CHECKING:  # pragma: no cover - typing only; never imported at runtime
    from fastmcp import FastMCP

__all__ = ["register_outbox"]

#: An outbox URI is a **name**: a scheme, then slash-separated segments of
#: lowercase letters and digits, with ``-`` and ``.`` allowed inside a segment.
#:
#: Far narrower than RFC 3986 allows, on purpose. Everything a URI may carry
#: beyond a name — percent escapes, userinfo, ports, dot segments, IP literals,
#: capitals — is something a reader normalises, and a URI that normalises is
#: registered at one address and read at another. Admitting the full grammar
#: means meeting each of those separately and finding the next one afterwards;
#: naming the small set an outbox actually uses retires the class at once.
#:
#: The narrowness is the safe direction. A URI this refuses and the host would
#: have taken fails loudly here, at registration, with the reason in the
#: message — and widening this pattern later cannot invalidate a URI already in
#: use. The reverse is not true, which is why it starts here.
_RESOURCE = re.compile(
    r"[a-z][a-z0-9+.\-]*://[a-z0-9]+(?:[-.][a-z0-9]+)*(?:/[a-z0-9]+(?:[-.][a-z0-9]+)*)*"
)

#: WHATWG's special schemes — the one thing the pattern cannot express, because
#: ``http`` is a well-formed scheme name like any other. A URL parser does not
#: carry these, it reinterprets them: ``http://x`` is read back as ``http://x/``,
#: which lists at an address no read resolves to.
#:
#: Refused on the argument the pattern itself rests on: an outbox is addressed by
#: **the server's own name**, and a scheme the world already owns is not that.
#: The set is frozen by the URL standard, so unlike the runtime's reserved list
#: this one does not grow.
_SPECIAL_SCHEMES = frozenset({"ftp", "file", "http", "https", "ws", "wss"})

#: What ``secured_session``-shaped factories are: called with the context,
#: used as an ``async with``. A server on ``[db]`` already has one.
SessionFactory = Callable[[SecurityContext], AbstractAsyncContextManager[AsyncConnection]]
IdentityFn = Callable[[], SecurityContext]
OnRead = Callable[[SecurityContext, AsyncConnection], Awaitable[int | None] | int | None]


def register_outbox(
    mcp: FastMCP,
    resource: str,
    session_factory: SessionFactory,
    identity_fn: IdentityFn,
    *,
    max_events: int = DEFAULT_MAX_EVENTS,
    on_read: OnRead | None = None,
    table: sa.Table | None = None,
    description: str | None = None,
) -> None:
    """Serve this server's outbox at the URI it declared.

    ``resource`` is the manifest's ``notifications.resource`` value, verbatim.
    The manifest is where the URI is declared and where the host reads it, so
    this argument must carry that same string — a server whose two disagree
    serves a URI the host never polls, and the failure surfaces as silence.

    ``session_factory(ctx)`` opens the transaction (the server's own secured
    session, such as ``SecuredDatabase.session``); ``identity_fn()`` builds the
    security context from the edge-injected headers, the same call the server's
    tools make. The handler runs inside the request's header context, which is
    what makes both possible.

    ``on_read(ctx, conn)`` runs first, in that same transaction, and may return
    a ``nextPollMs`` recommendation. It is how a server makes the poll its own
    tick: refresh what is pending, record what changed, and the events land in
    the answer to the poll that caused them. Returning a smaller number while
    something is pending asks the host to come back sooner; the host honours it
    inside its own floor and ceiling.

    ``max_events`` is the page size when the caller names none, and the ceiling
    it is held to when it does.

    Raises :class:`ValueError` for a ``resource`` that is not a **name** this
    module can serve unchanged: a scheme, ``://``, then slash-separated segments
    of lowercase letters and digits with ``-`` or ``.`` inside a segment. That
    is this module's own constraint rather than a restatement of the host's
    admission rule — see :func:`_check_resource`.
    """
    _check_resource(resource)
    uri = f"{resource}{{?cursor,maxEvents,maxAgeMs}}"

    # The parameter names are the RFC 6570 template's, so they are camelCase:
    # FastMCP matches a query parameter to the function argument of the same
    # name. Query parameters arrive as strings and are read as strings on purpose:
    # FastMCP coerces only bare `int` / `float` / `bool` annotations, so an
    # `int | None` would silently hand the handler a string, and a bare `int`
    # would turn a caller's typo into a resource-read failure instead of a
    # clamp. Absent parameters fall to these defaults.
    async def notifications(
        cursor: str | None = None,
        maxEvents: str | None = None,
        maxAgeMs: str | None = None,
    ) -> str:
        ctx = identity_fn()
        async with session_factory(ctx) as conn:
            next_poll_ms = await _run_hook(on_read, ctx, conn)
            result = await read(
                conn,
                ctx,
                cursor=cursor,
                max_events=_positive_int(maxEvents) or max_events,
                max_age_ms=_positive_int(maxAgeMs),
                next_poll_ms=next_poll_ms,
                table=table,
            )
        return json.dumps(result)

    notifications.__doc__ = description or (
        "Notifications this server has recorded but nobody asked for, oldest first. "
        "Poll with the cursor from the previous read; a read with no cursor starts "
        "from now and returns only a cursor."
    )

    mcp.resource(uri, name="notifications", mime_type="application/json")(notifications)


def _check_resource(resource: str) -> None:
    """Refuse a URI that is not a name this module can serve unchanged.

    One rule, and it is the whole of what this module checks: the string a
    server declares must be the string a reader resolves. Register something a
    parser normalises and the outbox lists at one address and answers at
    another, which is the same silence as an outbox nobody polls — the failure
    this guard exists for, arrived at by agreement rather than by error.

    :data:`_RESOURCE` is that rule as a pattern, and it is deliberately much
    narrower than a URI may be. The alternative — admit the RFC 3986 grammar and
    then exclude what normalises — needs a separate rule for percent escapes,
    for userinfo, for ports, for dot segments, for capitals, for IP literals,
    each one found after the last. A name has none of them to exclude.

    Deliberately **not** here: the length ceiling and the set of schemes the
    runtime resolves itself. Neither decides whether this template can be
    addressed — they decide whether a *declaration* is admissible, they belong
    to the manifest schema that defines a declaration's shape, and a second
    implementation of them here would be a second authority: two rules that
    agree on the inputs their authors thought of and diverge on the rest.
    """
    if not _RESOURCE.fullmatch(resource):
        raise ValueError(
            f"outbox resource {resource!r} is not a name this module can serve: it must be "
            "<scheme>://<segment>[/<segment>...], each segment lowercase letters and digits "
            "with '-' or '.' inside it. Anything a URL parser would rewrite is refused, "
            "because it would be read at a different address than it is registered under"
        )
    if resource.split(":", 1)[0] in _SPECIAL_SCHEMES:
        raise ValueError(
            f"outbox resource {resource!r} uses a scheme a URL parser reinterprets rather "
            "than carries; an outbox is addressed by the server's own name"
        )


async def _run_hook(
    on_read: OnRead | None, ctx: SecurityContext, conn: AsyncConnection
) -> int | None:
    if on_read is None:
        return None
    # Typed loosely on purpose: the hook may be a coroutine function or a plain
    # one, and both are ordinary things for an adopter to hand over.
    outcome: Any = on_read(ctx, conn)
    if inspect.isawaitable(outcome):
        outcome = await outcome
    return None if outcome is None else int(outcome)


def _positive_int(raw: str | None) -> int | None:
    """One query parameter as a positive int, or ``None`` for "not supplied".

    Absent, malformed and nonsensical all read as not supplied, so the caller
    falls to the default. A poll is a machine-to-machine call on a schedule, and
    a bad parameter in one is a bug in the caller that should not cost the
    workspace its notifications; ``read`` clamps the value in any case.
    """
    if raw is None:
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value > 0 else None
