"""Request-scoped observability context.

Holds the identity + correlation facts that every log line, metric exemplar, and
span should carry. Values are bound by the ASGI middleware from the *verified*
identity headers the edge sets (never from a request body), and read
back by the logging processor. Stored in ``contextvars`` so they are correct
under concurrent async requests without threading them through call signatures.
"""

from __future__ import annotations

from contextvars import ContextVar

# None when outside a request scope (e.g. startup, background jobs before binding).
_tenant_id: ContextVar[str | None] = ContextVar("nb_tenant_id", default=None)
_workspace_id: ContextVar[str | None] = ContextVar("nb_workspace_id", default=None)
_correlation_id: ContextVar[str | None] = ContextVar("nb_correlation_id", default=None)
# The INFRA-PLANE identity axis: a shared service with no tenant is attributed by its
# *caller* instead. Only set for
# services that opt in via ``instrument_app(caller_resolver=...)``; None (absent
# from logs) for every tenant/fleet service, so their log shape is unchanged.
_caller: ContextVar[str | None] = ContextVar("nb_caller", default=None)


def bind_context(
    *,
    tenant_id: str | None = None,
    workspace_id: str | None = None,
    correlation_id: str | None = None,
    caller: str | None = None,
) -> None:
    """Bind the request-scoped identity/correlation facts. Idempotent per scope."""
    if tenant_id is not None:
        _tenant_id.set(tenant_id)
    if workspace_id is not None:
        _workspace_id.set(workspace_id)
    if correlation_id is not None:
        _correlation_id.set(correlation_id)
    if caller is not None:
        _caller.set(caller)


def clear_context() -> None:
    """Reset to outside-a-request state. The middleware calls this per request."""
    _tenant_id.set(None)
    _workspace_id.set(None)
    _correlation_id.set(None)
    _caller.set(None)


def current_context() -> dict[str, str]:
    """The bound identity facts, omitting anything unset. Used by the logging
    processor.

    NOTE: `correlation_id` is deliberately NOT logged. The log line's
    trace-correlation field is the OTel-standard `trace_id`, stamped from the
    active span by the logging layer (a real trace id or nothing — never a
    fabricated value). `correlation_id` remains a request-domain concept
    (the `x-correlation-id` echo header — see `get_correlation_id`), distinct
    from the trace id, and stays out of the log schema.
    """
    out: dict[str, str] = {}
    if (tid := _tenant_id.get()) is not None:
        out["tenant_id"] = tid
    if (wid := _workspace_id.get()) is not None:
        out["workspace_id"] = wid
    if (caller := _caller.get()) is not None:
        out["caller"] = caller
    return out


def get_correlation_id() -> str | None:
    return _correlation_id.get()
