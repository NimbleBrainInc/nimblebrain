"""The errors a server raises and the errors it returns.

``HostCapabilityMissing`` signals a local condition ("this connection cannot carry a
host-resources request") rather than a wire response. Wire-level errors from the host come
through as `mcp.shared.exceptions.MCPError`; the SDK does not wrap those, so server code
matches on the JSON-RPC error code through the standard exception path. The other errors the
SDK raises are ``ValueError`` and ``TypeError`` for a bad argument at registration or call
time, ``MissingExtraError`` for a subpackage imported without its extra, and, from the
extras, the errors each documents (``[db]``'s ``AuthError``, ``Overloaded``,
``PoolConfigError`` and ``UnsafeRoleError``).

The rest is the service error contract: how a server reports a failure that crosses its
boundary, so every server fails the same way and no upstream's internals reach the host.

* ``ServiceError`` is the typed failure. Its ``code`` is one of the closed set in
  ``ErrorCode``, which fixes the HTTP status a host presents and whether a retry can help.
  ``message`` crosses to the host and stays generic; ``detail`` is for operators and goes to
  logs only.
* ``ServiceError.from_upstream`` classifies a raw upstream HTTP status into that set.
* ``to_tool_error`` turns a ``ServiceError`` into the FastMCP tool result to ``return``, and
  ``rate_limited_tool_error`` does the same for a call refused for capacity.
* ``add_error_contract`` (in the package root) makes a server return either one for a
  ``ServiceError`` or capacity refusal a tool *raises*, so a tool need not catch them.

Surfacing an error also records it: one ``service_error`` log line and one increment of
``service_errors_total{service, code, upstream_status}``. Both come from
``nimblebrain_server_sdk.observability`` when the ``[observability]`` extra is installed.
Without it the tool result is the same, the metric is not recorded, and the log line goes to
the standard library logger ``nimblebrain_server_sdk.errors``. This module imports neither
the extra nor FastMCP until an error is surfaced.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from enum import StrEnum
from functools import cache
from typing import Any, Protocol

from nimblebrain_server_sdk._extras import MissingExtraError

__all__ = [
    "CapacityRefusal",
    "ErrorCode",
    "HostCapabilityMissing",
    "ServiceError",
    "rate_limited_tool_error",
    "to_tool_error",
]


class HostCapabilityMissing(Exception):
    """Raised by a host-resources call the connection cannot carry.

    Either the host did not advertise the capability, or the connection negotiated the
    2026-07-28 protocol, which has no channel for a request from a server to its client. The
    message says which. Catch it, or check ``host(ctx).available`` first, and return a tool
    error that tells the agent to pass the content inline instead:

        ```python
        try:
            result = await host(ctx).read(seed_uri)
        except HostCapabilityMissing:
            return to_tool_error(
                ServiceError(
                    ErrorCode.BAD_INPUT,
                    "This connection cannot read workspace files. Pass the file's contents "
                    "in `seed_data` instead.",
                )
            )
        ```

    ``protocol_version`` is the negotiated version when the protocol era is the cause, else
    ``None``.
    """

    def __init__(self, capability_key: str, *, protocol_version: str | None = None) -> None:
        if protocol_version is None:
            cause = f"Host has not advertised the {capability_key!r} capability."
        else:
            cause = (
                f"This connection negotiated MCP protocol {protocol_version}, which has no "
                f"channel for a request from a server to its client, so {capability_key!r} "
                "cannot be used on it whatever the host advertised. It works on a connection "
                "that negotiated 2025-11-25 or earlier."
            )
        super().__init__(
            f"{cause} Check `host(ctx).available` before calling read/list, or pass "
            "content via tool arguments instead."
        )
        self.capability_key = capability_key
        self.protocol_version = protocol_version


class ErrorCode(StrEnum):
    """The closed set of cross-cutting error codes."""

    BAD_INPUT = "bad_input"
    AUTH_REQUIRED = "auth_required"
    FORBIDDEN = "forbidden"
    NOT_FOUND = "not_found"
    CONFLICT = "conflict"
    QUOTA_EXHAUSTED = "quota_exhausted"
    RATE_LIMITED = "rate_limited"
    UPSTREAM_REJECTED = "upstream_rejected"
    UPSTREAM_UNAVAILABLE = "upstream_unavailable"
    UPSTREAM_TIMEOUT = "upstream_timeout"
    INTERNAL = "internal"


# code -> (http_status, retryable). `http_status` is what a consumer presents to the host: an
# HTTP service returns it directly, and the host returns it when it relays an in-band tool
# error carrying this code. The NimbleBrain host and the platform's other services hold the
# same table; a change here is a change to what every one of them reports.
_META: dict[ErrorCode, tuple[int, bool]] = {
    ErrorCode.BAD_INPUT: (400, False),
    ErrorCode.AUTH_REQUIRED: (401, False),
    ErrorCode.FORBIDDEN: (403, False),
    ErrorCode.NOT_FOUND: (404, False),
    ErrorCode.CONFLICT: (409, False),
    ErrorCode.QUOTA_EXHAUSTED: (502, False),
    ErrorCode.RATE_LIMITED: (429, True),
    ErrorCode.UPSTREAM_REJECTED: (502, False),
    ErrorCode.UPSTREAM_UNAVAILABLE: (503, True),
    ErrorCode.UPSTREAM_TIMEOUT: (504, True),
    ErrorCode.INTERNAL: (500, False),
}


# Host-safe default message per code. Generic by design: no vendor name, URL, or raw upstream
# text (those are operator-only, in `detail`). A caller may override with its own host-safe
# string.
_DEFAULT_MESSAGE: dict[ErrorCode, str] = {
    ErrorCode.BAD_INPUT: "The request arguments were invalid.",
    ErrorCode.AUTH_REQUIRED: "Authorization with an upstream service is required.",
    ErrorCode.FORBIDDEN: "The operation is not permitted.",
    ErrorCode.NOT_FOUND: "The requested resource was not found.",
    ErrorCode.CONFLICT: "The request conflicts with the current state.",
    ErrorCode.QUOTA_EXHAUSTED: (
        "A third-party service rejected the request (usage quota or credits exhausted)."
    ),
    ErrorCode.RATE_LIMITED: "Rate limited by an upstream service; retry shortly.",
    ErrorCode.UPSTREAM_REJECTED: "A third-party service rejected the request.",
    ErrorCode.UPSTREAM_UNAVAILABLE: "A third-party service is temporarily unavailable.",
    ErrorCode.UPSTREAM_TIMEOUT: "A third-party service did not respond in time.",
    ErrorCode.INTERNAL: "The service encountered an internal error.",
}


def _classify_upstream(status: int) -> ErrorCode:
    """Map a raw upstream HTTP status onto the taxonomy.

    The single place the "what does a 4xx/5xx from someone we called mean" rule
    lives, so every service classifies an upstream the same way.
    """
    if status == 402:
        return ErrorCode.QUOTA_EXHAUSTED
    if status == 401:
        return ErrorCode.AUTH_REQUIRED
    if status == 403:
        return ErrorCode.FORBIDDEN
    if status == 404:
        return ErrorCode.NOT_FOUND
    if status == 409:
        return ErrorCode.CONFLICT
    if status == 429:
        return ErrorCode.RATE_LIMITED
    if status in (408, 504):
        return ErrorCode.UPSTREAM_TIMEOUT
    if 500 <= status <= 599:
        return ErrorCode.UPSTREAM_UNAVAILABLE
    if 400 <= status <= 499:
        return ErrorCode.UPSTREAM_REJECTED
    # A 2xx/3xx reaching here is itself anomalous — treat as a rejection we can't read.
    return ErrorCode.UPSTREAM_REJECTED


class ServiceError(Exception):
    """A classified, host-safe failure crossing a service boundary.

    ``message`` crosses the trust boundary to the host — keep it generic; NEVER
    put a vendor name/URL, raw upstream body, secret, or tenant data in it.
    ``detail`` is operator-only (logs); it never reaches the host envelope.

    Domain-specific failures subclass this and override ``metric_code`` to roll
    up to one of the cross-cutting codes for the metric label (so the
    ``service_errors_total{code=...}`` label stays the closed set).
    """

    def __init__(
        self,
        code: ErrorCode,
        message: str | None = None,
        *,
        upstream_status: int | None = None,
        retryable: bool | None = None,
        detail: str | None = None,
    ) -> None:
        message = message or _DEFAULT_MESSAGE[code]
        super().__init__(message)
        self.code = code
        self.message = message
        self.upstream_status = upstream_status
        self.detail = detail
        default_status, default_retryable = _META[code]
        self.http_status = default_status
        self.retryable = default_retryable if retryable is None else retryable

    @classmethod
    def from_upstream(
        cls,
        status: int,
        message: str | None = None,
        *,
        detail: str | None = None,
    ) -> ServiceError:
        """Build from a raw upstream HTTP status (the common provider-error path).

        The bare ``status`` number is stamped as host-safe ``upstream_status``; the
        vendor's prose belongs in ``detail`` (logs only), never in ``message``.
        Omit ``message`` to use the classified code's host-safe default.
        """
        return cls(
            _classify_upstream(status),
            message,
            upstream_status=status,
            detail=detail,
        )

    @property
    def metric_code(self) -> str:
        """The closed-set code used as the ``service_errors_total`` label.

        Cross-cutting errors are their own code; domain subclasses override this
        to roll up, keeping the metric's label set bounded.
        """
        return self.code.value

    def to_envelope(self) -> dict[str, object]:
        """The host-safe error payload (HTTP body / MCP ``structuredContent.error``)."""
        env: dict[str, object] = {
            "code": self.code.value,
            "retryable": self.retryable,
            "message": self.message,
        }
        if self.upstream_status is not None:
            env["upstream_status"] = self.upstream_status
        return env


_log = logging.getLogger(__name__)

_CALLER_SIDE = frozenset(
    {ErrorCode.BAD_INPUT, ErrorCode.NOT_FOUND, ErrorCode.CONFLICT, ErrorCode.FORBIDDEN}
)


def _log_level(err: ServiceError) -> int:
    """The level a surfaced error is logged at: ``WARNING`` for the caller's side, else ``ERROR``.

    ``bad_input``, ``not_found``, ``conflict`` and ``forbidden`` are the caller's mistake or a
    routine answer, and the server worked as intended, so they stay out of an error-level alert.
    That holds for a ``forbidden`` built from an upstream 403 too, which is most often one
    user's permission. ``auth_required`` stays at ``ERROR`` whatever its origin: it is either a
    request that did not come through the edge or the server's own credential failing upstream.
    Every error is still counted in ``service_errors_total``.
    """
    return logging.WARNING if err.code in _CALLER_SIDE else logging.ERROR


def _log_only(err: ServiceError) -> None:
    """Record ``err`` without ``[observability]``: the same fields, on the stdlib logger."""
    _log.log(
        _log_level(err),
        "service_error",
        extra={
            "code": err.code.value,
            "retryable": err.retryable,
            "upstream_status": err.upstream_status,
            "http_status": err.http_status,
            "detail": err.detail,
        },
    )


@cache
def _recorder() -> Callable[[ServiceError], None]:
    """How a surfaced error is recorded: the metric and log line when ``[observability]`` is
    installed, else the log line alone. Resolved on the first surfaced error, not at import, so
    importing this module never imports the extra."""
    try:
        from nimblebrain_server_sdk.observability.error_surface import _record
    except MissingExtraError:
        return _log_only
    return _record


def _record(err: ServiceError) -> None:
    """Emit the signal for a classified error (exactly once)."""
    _recorder()(err)


def to_tool_error(err: ServiceError) -> Any:
    """A real ``fastmcp.ToolResult(is_error=True)`` to ``return`` from a tool.

    Returns the FastMCP result object — NOT a dict. Returning a plain dict does
    NOT work: FastMCP scores a returned dict as ``is_error=False`` (a success with
    the flag buried in structured data), which reproduces the very in-band-error
    footgun this contract exists to prevent. The sanitized ``message`` is the text
    block; ``structured_content.error`` carries the envelope.

    Imports ``fastmcp`` when called, so importing this module does not.
    """
    from fastmcp.tools import ToolResult
    from mcp.types import TextContent

    _record(err)
    return ToolResult(
        content=[TextContent(type="text", text=err.message)],
        structured_content={"error": err.to_envelope()},
        is_error=True,
    )


class CapacityRefusal(Protocol):
    """A call refused for capacity before it ran anything, carrying host-safe text.

    ``nimblebrain_server_sdk.db.Overloaded`` is one; this module names the shape rather than
    the class, so it takes no database dependency.
    """

    message: str
    next_step: str


def rate_limited_tool_error(refusal: CapacityRefusal) -> Any:
    """The ``rate_limited`` tool error for a call refused for capacity, to ``return``.

    Classified, counted and logged like any ``ServiceError``. The host sees the refusal's own
    message and what to do next; the code is retryable, and the call ran nothing.
    """
    return to_tool_error(
        ServiceError(ErrorCode.RATE_LIMITED, message=f"{refusal.message} {refusal.next_step}")
    )
