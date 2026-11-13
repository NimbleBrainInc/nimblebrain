"""Error instrumentation: the ``service_errors_total`` signal and the ``service_error`` log line.

The error contract itself (``ServiceError``, ``ErrorCode``, ``to_tool_error``,
``rate_limited_tool_error``) is in the SDK's core, ``nimblebrain_server_sdk.errors``, so a
server can raise and return classified errors without this extra. When the extra is
installed, the core records every error it surfaces through :func:`_record` here: one
increment of ``service_errors_total`` and one structured log line, exactly once per error.

Kept apart from the contract type so that instrumentation, not the taxonomy, is what couples
to the metrics registry.
"""

from __future__ import annotations

from nimblebrain_server_sdk.errors import ServiceError

from .logging import get_logger
from .metrics import record_service_error

_log = get_logger(__name__)


def _record(err: ServiceError) -> None:
    """Emit the metric + structured log for a classified error (exactly once)."""
    record_service_error(err.metric_code, err.upstream_status)
    _log.error(
        "service_error",
        code=err.code.value,
        retryable=err.retryable,
        upstream_status=err.upstream_status,
        http_status=err.http_status,
        detail=err.detail,  # operator-only; the raw vendor string lives here, never on the wire
    )
