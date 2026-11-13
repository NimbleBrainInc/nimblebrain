"""Golden: the JSON log line, whole, as a log backend receives it.

Every key and value of the lines an instrumented service writes to stdout, per scenario: a
structlog line and a stdlib ``extra`` line inside a request carrying the edge's identity
headers and a ``traceparent``, an exception, a classified ``service_error``, a line outside
any request, and an infra-plane line attributed to its ``caller``. ``level`` and ``service``
are promoted to stream labels at ingest; ``tenant_id``, ``workspace_id`` and
``trace_id`` (the log-to-trace pivot) are read from the JSON. ``correlation_id`` is not a
log field: it is the ``x-correlation-id`` response header, pinned here too.

Volatile values are checked for shape, then replaced by a placeholder: ``timestamp`` (ISO
8601 UTC, microseconds) and the ``exception`` traceback.

``tests/golden/log_lines.json`` is frozen output with no regenerate path.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

# The library under test: only these lines name it.
from nimblebrain_server_sdk.observability import (
    ServiceError,
    get_logger,
    instrument_app,
    to_tool_error,
)

GOLDEN = Path(__file__).parent / "golden" / "log_lines.json"

TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
TRACEPARENT = f"00-{TRACE_ID}-b7ad6b7169203331-01"
IDENTITY = {"x-tenant-id": "tenant-a", "x-workspace-id": "ws-a", "traceparent": TRACEPARENT}

_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$")


def _app(**instrument: Any) -> FastAPI:
    app = FastAPI()

    @app.get("/golden/log")
    def structured() -> dict:
        get_logger("golden.handler").info("golden_structured", item_id="item-1", count=2)
        return {}

    @app.get("/golden/stdlib")
    def stdlib() -> dict:
        logging.getLogger("golden.stdlib").warning("golden_stdlib", extra={"item_id": "item-1"})
        return {}

    @app.get("/golden/exception")
    def exception() -> dict:
        try:
            raise ValueError("golden failure")
        except ValueError:
            get_logger("golden.handler").exception("golden_exception")
        return {}

    @app.get("/golden/service-error")
    def service_error() -> dict:
        to_tool_error(ServiceError.from_upstream(402, detail="operator-only text"))
        return {}

    instrument_app(app, service="golden-svc", **instrument)
    return app


def _normalize(line: dict[str, Any]) -> dict[str, Any]:
    assert _TIMESTAMP.match(line["timestamp"]), line["timestamp"]
    line["timestamp"] = "<timestamp>"
    if "exception" in line:
        assert line["exception"].startswith("Traceback (most recent call last):\n")
        assert line["exception"].endswith("\nValueError: golden failure")
        line["exception"] = "<traceback>"
    return line


def _lines(out: str) -> list[dict[str, Any]]:
    """The JSON lines a golden scenario wrote (each scenario's events start with ``golden``)."""
    lines = []
    for raw in out.splitlines():
        try:
            line = json.loads(raw)
        except ValueError:
            continue
        if line.get("event", "").startswith("golden") or line.get("event") == "service_error":
            lines.append(_normalize(line))
    return lines


def _caller_resolver(get_header) -> str:
    return get_header("x-golden-caller") or "unknown"


def build(capsys: pytest.CaptureFixture[str]) -> dict[str, Any]:
    capsys.readouterr()
    out: dict[str, Any] = {}

    client = TestClient(_app())
    for name, path in [
        ("structured", "/golden/log"),
        ("stdlib_extra", "/golden/stdlib"),
        ("exception", "/golden/exception"),
        ("service_error", "/golden/service-error"),
    ]:
        client.get(path, headers=IDENTITY)
        out[name] = _lines(capsys.readouterr().out)

    get_logger("golden.outside").info("golden_outside_request", item_id="item-1")
    out["outside_request"] = _lines(capsys.readouterr().out)

    caller_client = TestClient(_app(caller_resolver=_caller_resolver))
    caller_client.get(
        "/golden/log", headers={"x-golden-caller": "caller-a", "traceparent": TRACEPARENT}
    )
    out["infra_plane_caller"] = _lines(capsys.readouterr().out)

    out["correlation_header"] = {
        "from_traceparent": client.get("/golden/log", headers=IDENTITY).headers.get_list(
            "x-correlation-id"
        ),
        "from_x_correlation_id": client.get(
            "/golden/log", headers={"x-correlation-id": "corr-a"}
        ).headers.get_list("x-correlation-id"),
    }
    minted = client.get("/golden/log").headers.get_list("x-correlation-id")
    assert len(minted) == 1 and re.fullmatch(r"[0-9a-f]{32}", minted[0]), minted
    capsys.readouterr()
    return out


def test_log_lines_match_golden(capsys: pytest.CaptureFixture[str]) -> None:
    actual = json.loads(json.dumps(build(capsys)))
    assert actual == json.loads(GOLDEN.read_text())


def test_no_line_carries_correlation_id() -> None:
    """``correlation_id`` stays out of the log schema: it is the response header only."""
    golden = GOLDEN.read_text()
    assert '"correlation_id"' not in golden
