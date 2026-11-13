"""Golden: every name a consumer imports from the library, and its parameters.

The names are the ones consumers import. Each is pinned by kind and, for a
callable, by its parameters (name, kind, default), not by annotation strings, which can
change legitimately when a name is re-exported from another package. ``ServiceError`` is
pinned with the attributes and methods consumers read.

``tests/golden/public_api.json`` is frozen output with no regenerate path.
"""

from __future__ import annotations

import inspect
import json
from pathlib import Path
from types import ModuleType
from typing import Any

# The library under test: only these lines name it.
import nimblebrain_server_sdk.observability as package
from nimblebrain_server_sdk.observability import logging as package_logging
from nimblebrain_server_sdk.observability import metrics as package_metrics

GOLDEN = Path(__file__).parent / "golden" / "public_api.json"

#: (module key, name) for each consumed name; "" is the package itself.
CONSUMED: dict[str, tuple[ModuleType, tuple[str, ...]]] = {
    "": (
        package,
        (
            "CapacityRefusal",
            "ErrorCode",
            "ServiceError",
            "configure_logging",
            "counter",
            "gauge",
            "get_logger",
            "histogram",
            "inject_trace_headers",
            "instrument_app",
            "rate_limited_tool_error",
            "render",
            "service_version",
            "start_metrics_server",
            "to_tool_error",
        ),
    ),
    "logging": (package_logging, ("get_logger",)),
    "metrics": (
        package_metrics,
        ("REGISTRY", "counter", "gauge", "histogram", "record_service_error"),
    ),
}


def _parameters(fn: Any) -> list[dict[str, str]]:
    return [
        {
            "name": p.name,
            "kind": p.kind.name,
            "default": "<required>" if p.default is inspect.Parameter.empty else repr(p.default),
        }
        for p in inspect.signature(fn).parameters.values()
    ]


def _describe(obj: Any) -> dict[str, Any]:
    if inspect.isclass(obj):
        out: dict[str, Any] = {
            "kind": "class",
            "bases": [base.__name__ for base in obj.__bases__],
        }
        if fields := inspect.get_annotations(obj):
            out["fields"] = sorted(fields)
        return out
    if callable(obj):
        return {"kind": "function", "parameters": _parameters(obj)}
    return {"kind": "object", "type": type(obj).__name__}


def _service_error() -> dict[str, Any]:
    err = package.ServiceError(package.ErrorCode.INTERNAL)
    return {
        "__init__": _parameters(package.ServiceError.__init__),
        "from_upstream": _parameters(package.ServiceError.from_upstream),
        "to_envelope": _parameters(err.to_envelope),
        "instance_attributes": sorted(vars(err)),
        "metric_code_is_property": isinstance(
            inspect.getattr_static(package.ServiceError, "metric_code"), property
        ),
    }


def build() -> dict[str, Any]:
    names = {
        f"{key}:{name}": _describe(getattr(module, name))
        for key, (module, consumed) in CONSUMED.items()
        for name in consumed
    }
    return {
        "names": names,
        "ServiceError": _service_error(),
        "ErrorCode": [[member.name, member.value] for member in package.ErrorCode],
        "same_object": {
            "logging:get_logger is :get_logger": package_logging.get_logger is package.get_logger,
            "metrics:counter is :counter": package_metrics.counter is package.counter,
            "metrics:gauge is :gauge": package_metrics.gauge is package.gauge,
            "metrics:histogram is :histogram": package_metrics.histogram is package.histogram,
        },
    }


def test_public_api_matches_golden() -> None:
    actual = json.loads(json.dumps(build()))
    assert actual == json.loads(GOLDEN.read_text())
