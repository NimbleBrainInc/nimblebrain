"""The host context: who is calling and the scope a call is walled to.

A NimbleBrain host stamps it on every request it sends to a plugin server, at
``params._meta["ai.nimblebrain/context"]``. Its shape is the published schema
``https://schemas.nimblebrain.ai/host-context/v1/host-context.schema.json``, and the reader here
accepts exactly what that schema accepts: a value it refuses is no context. The rules are the
host context specification (``contracts/host-context/CONTEXT.md`` in the NimbleBrain repository).

Reading is not trusting. A server believes the context only from an authenticated host
transport: stdio, which the host alone holds, or HTTP with the credential the operator issued
to the host for that server.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal, TypeGuard

from fastmcp import Context

#: The request ``_meta`` key the host context travels under.
HOST_CONTEXT_META_KEY = "ai.nimblebrain/context"

#: Who is calling: ``host``, the host's own code, or ``person``, a user directly or through an
#: agent or an app.
Principal = Literal["host", "person"]

# The schema's ``now``: an RFC 3339 instant in UTC, ``Z`` only, fractional seconds allowed. The
# schema's pattern is ECMA-262, where ``\d`` is an ASCII digit and ``$`` ends the string, so the
# Python form names the digits and is matched whole.
_NOW = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z")

# The longest grant the schema accepts.
_MAX_GRANT_LENGTH = 4096

# The optional string fields: (wire name, attribute name).
_STRINGS = (
    ("workspaceId", "workspace_id"),
    ("ownerId", "owner_id"),
    ("conversationId", "conversation_id"),
    ("runId", "run_id"),
)


@dataclass(frozen=True, slots=True, kw_only=True)
class HostContext:
    """The host context of one call, as the schema defines it.

    Every field but ``principal`` is ``None`` when the host did not stamp it: a dimension the
    host cannot verify is left out, never guessed.

    - ``principal``: ``host`` or ``person``.
    - ``workspace_id``: the workspace the call is walled to.
    - ``owner_id``: the verified identity whose records the call reads and writes.
    - ``conversation_id``: the conversation the call is made inside, during a chat turn.
    - ``run_id``: the unattended run the call is made inside, or that a host call is made for.
    - ``grant``: the run grant, on a person's call to a tool its contract marks
      ``grant: true``. Opaque: store it and return it verbatim, never parse it or show it.
      It is left out of the ``repr``, so logging a context does not print it.
    - ``unattended``: ``True`` when the call is made inside an unattended run, with no person
      present. A server refuses a tool its contract marks ``unattended: "refused"`` on such a
      call.
    - ``now``: the host's clock when it sent the request, an RFC 3339 instant in UTC (``Z``),
      as the host wrote it. A decision a contract assigns to the call's ``now`` is taken on it,
      never on the server's own clock; parse it with ``datetime.fromisoformat`` when needed.
    """

    principal: Principal
    workspace_id: str | None = None
    owner_id: str | None = None
    conversation_id: str | None = None
    run_id: str | None = None
    grant: str | None = field(default=None, repr=False)
    unattended: bool | None = None
    now: str | None = None

    @property
    def is_host(self) -> bool:
        """Whether the call is the host's own (``principal == "host"``)."""
        return self.principal == "host"


def _is_text(value: object, max_length: int | None = None) -> TypeGuard[str]:
    """A non-empty string no longer than ``max_length`` code points."""
    return (
        isinstance(value, str)
        and len(value) > 0
        and (max_length is None or len(value) <= max_length)
    )


def read_host_context(meta: object) -> HostContext | None:
    """The host context in a request's ``params._meta``, or ``None`` when there is none.

    ``meta`` is the request's whole ``_meta`` mapping (or ``None``). The context is read from
    its ``ai.nimblebrain/context`` key. A value that fails the schema is no context and reads
    as ``None``: one with no ``principal``, a ``principal`` other than ``host`` or ``person``,
    or any known field of the wrong type or form (an empty id, a grant over 4096 characters, a
    ``now`` that is not a UTC RFC 3339 instant). Fields the schema does not name are ignored.

    In a FastMCP tool, :func:`host_context` reads it from the tool's ``Context``.
    """
    if not isinstance(meta, Mapping):
        return None
    raw = meta.get(HOST_CONTEXT_META_KEY)
    if not isinstance(raw, Mapping):
        return None
    principal = raw.get("principal")
    if principal != "host" and principal != "person":
        return None
    strings: dict[str, str] = {}
    for wire, attribute in _STRINGS:
        if wire not in raw:
            continue
        value = raw[wire]
        if not _is_text(value):
            return None
        strings[attribute] = value
    grant = raw.get("grant")
    if "grant" in raw and not _is_text(grant, _MAX_GRANT_LENGTH):
        return None
    now = raw.get("now")
    if "now" in raw and (not isinstance(now, str) or _NOW.fullmatch(now) is None):
        return None
    unattended = raw.get("unattended")
    if "unattended" in raw and not isinstance(unattended, bool):
        return None
    return HostContext(
        principal=principal,
        workspace_id=strings.get("workspace_id"),
        owner_id=strings.get("owner_id"),
        conversation_id=strings.get("conversation_id"),
        run_id=strings.get("run_id"),
        grant=grant,
        unattended=unattended,
        now=now,
    )


def host_context(ctx: Context) -> HostContext | None:
    """The host context of the tool call ``ctx`` serves, or ``None`` when it carries none.

    Reads ``params._meta["ai.nimblebrain/context"]`` of the request in progress, by the rules of
    :func:`read_host_context`. ``None`` also outside a request. A call with no context names
    no principal and has no scope: it is not ``host``, and the server answers it as its
    contract says for a missing context.

    Believe it only from an authenticated host transport; the SDK reads, the server decides
    whether its transport is the host's.
    """
    request_context = ctx.request_context
    if request_context is None:
        return None
    return read_host_context(request_context.meta)


def is_host(context: HostContext | None) -> bool:
    """Whether a call is the host's own. A call with no context, or that names no principal,
    is not."""
    return context is not None and context.is_host
