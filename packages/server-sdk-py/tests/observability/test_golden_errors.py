"""Golden: the error contract hosts and agents read.

Pins, per ``ErrorCode``: its string value, HTTP status, retryability and host-safe default
message; the envelope ``to_envelope`` builds; and the exact tool result ``to_tool_error``
returns. Also how ``ServiceError.from_upstream`` classifies an upstream HTTP status, the
labels each surfaced error adds to ``service_errors_total``, and ``rate_limited_tool_error``.

``tests/golden/error_contract.json`` is frozen output with no regenerate path: a change to
it is a change to what every host sees.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# The library under test: only these lines name it.
from nimblebrain_server_sdk.observability import (
    ErrorCode,
    ServiceError,
    rate_limited_tool_error,
    to_tool_error,
)
from nimblebrain_server_sdk.observability.metrics import REGISTRY

GOLDEN = Path(__file__).parent / "golden" / "error_contract.json"

#: Upstream statuses a provider can answer with: each class boundary and each special case.
UPSTREAM_STATUSES = (
    200, 302, 400, 401, 402, 403, 404, 405, 408, 409, 410, 418, 422, 429,
    499, 500, 501, 502, 503, 504, 599,
)  # fmt: skip


class _Refusal:
    message = "The workspace is at capacity. Nothing was run."
    next_step = "Retry shortly."


def _wire(result: Any) -> dict[str, Any]:
    """The fields of a tool result the host receives."""
    return {
        "content": [block.model_dump(mode="json", exclude_none=True) for block in result.content],
        "structured_content": result.structured_content,
        "is_error": result.is_error,
        "meta": result.meta,
    }


def _service_errors() -> dict[tuple[tuple[str, str], ...], float]:
    """Every ``service_errors_total`` series and its value."""
    return {
        tuple(sorted(sample.labels.items())): sample.value
        for family in REGISTRY.collect()
        if family.name == "service_errors"
        for sample in family.samples
        if sample.name == "service_errors_total"
    }


def _surfaced(err: ServiceError) -> dict[str, Any]:
    """Surface ``err`` as a tool error; return the result and the series it counted on."""
    before = _service_errors()
    result = to_tool_error(err)
    after = _service_errors()
    counted = [dict(k) for k, v in after.items() if v - before.get(k, 0.0) == 1.0]
    for labels in counted:
        labels.pop("service")  # process-scoped; pinned by the metrics golden
    return {"tool_result": _wire(result), "service_errors_total": counted}


def _describe(err: ServiceError) -> dict[str, Any]:
    return {
        "code": err.code.value,
        "message": err.message,
        "http_status": err.http_status,
        "retryable": err.retryable,
        "upstream_status": err.upstream_status,
        "metric_code": err.metric_code,
        "envelope": err.to_envelope(),
    }


def build() -> dict[str, Any]:
    return {
        "codes": [
            {**_describe(ServiceError(code)), **_surfaced(ServiceError(code))} for code in ErrorCode
        ],
        "from_upstream": {
            str(status): {
                **_describe(ServiceError.from_upstream(status, detail="vendor prose")),
                **_surfaced(ServiceError.from_upstream(status, detail="vendor prose")),
            }
            for status in UPSTREAM_STATUSES
        },
        "overrides": {
            "message_and_retryable": _describe(
                ServiceError(ErrorCode.UPSTREAM_REJECTED, "Custom host-safe text.", retryable=True)
            ),
            "from_upstream_with_message": _describe(
                ServiceError.from_upstream(503, "Search is down.", detail="vendor prose")
            ),
        },
        "rate_limited_tool_error": _wire(rate_limited_tool_error(_Refusal())),
    }


def test_error_contract_matches_golden() -> None:
    actual = json.loads(json.dumps(build()))
    assert actual == json.loads(GOLDEN.read_text())


def test_detail_never_reaches_the_host() -> None:
    """``detail`` is operator-only: no tool result in the golden may carry it."""
    assert "vendor prose" not in GOLDEN.read_text()
