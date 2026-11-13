"""Golden: the metric families the library registers and what ``GET /metrics`` exposes.

Dashboards and alert rules query these by name and label (``http_requests_total{status=~"5.."}``,
``service_errors_total{code="quota_exhausted"}``), so a rename or a dropped label is a silent
break, not an error. Pinned whole:

- ``registered``: every family the library declares, with its type, label names and, for a
  histogram, its bucket bounds.
- ``factories``: what ``counter``/``gauge``/``histogram`` declare for a service, defaults
  included (a histogram declared without ``buckets`` gets the duration buckets).
- ``exposition``: the scrape after an instrumented app served a matched route, an unmatched
  path, a failing route and a surfaced service error: each series name with its label set,
  and the content type Prometheus is served.

``tests/golden/metrics.json`` is frozen output with no regenerate path.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from prometheus_client.metrics import MetricWrapperBase
from prometheus_client.parser import text_string_to_metric_families
from starlette.testclient import TestClient

# The library under test: only these lines name it.
from nimblebrain_server_sdk.observability import (
    ErrorCode,
    ServiceError,
    counter,
    gauge,
    histogram,
    instrument_app,
    to_tool_error,
)
from nimblebrain_server_sdk.observability import metrics as library_metrics

GOLDEN = Path(__file__).parent / "golden" / "metrics.json"


def family(metric: MetricWrapperBase) -> dict[str, Any]:
    """A declared family as a scrape names it: name, type, label names, histogram buckets."""
    out: dict[str, Any] = {
        "name": metric._name,
        "type": metric._type,
        "labels": list(metric._labelnames),
    }
    if metric._type == "histogram":
        out["buckets"] = [str(bound) for bound in metric._upper_bounds]  # ty: ignore[unresolved-attribute]
    return out


def _registered() -> list[dict[str, Any]]:
    declared = {
        id(obj): obj for obj in vars(library_metrics).values() if isinstance(obj, MetricWrapperBase)
    }
    return sorted((family(m) for m in declared.values()), key=lambda f: f["name"])


def _factories() -> list[dict[str, Any]]:
    return [
        family(counter("golden_factory_counter_total", "c", ("kind",))),
        family(counter("golden_factory_unlabelled_total", "c")),
        family(gauge("golden_factory_gauge", "g", ("kind",))),
        family(histogram("golden_factory_seconds", "h", ("kind",))),
        family(histogram("golden_factory_sizes", "h", buckets=(1.0, 10.0, 100.0))),
    ]


def _app() -> FastAPI:
    app = FastAPI()

    @app.get("/golden-metrics/items/{item_id}")
    def item(item_id: str) -> dict:
        return {"item_id": item_id}

    @app.get("/golden-metrics/fail")
    def fail() -> dict:
        raise RuntimeError("golden failure")

    @app.get("/golden-metrics/tool-error")
    def tool_error() -> dict:
        to_tool_error(ServiceError(ErrorCode.NOT_FOUND))
        to_tool_error(ServiceError.from_upstream(429))
        return {}

    instrument_app(app, service="golden-metrics-svc")
    return app


def _exposition() -> dict[str, Any]:
    client = TestClient(_app(), raise_server_exceptions=False)
    client.get("/golden-metrics/items/item-1")
    client.get("/golden-metrics/items/item-2")
    client.get("/golden-metrics/no-such-route")
    client.get("/golden-metrics/fail")
    client.get("/golden-metrics/tool-error")
    response = client.get("/metrics")

    own = {f["name"] for f in _registered()}
    families = []
    for scraped in text_string_to_metric_families(response.text):
        # A family and its ``_created`` companion, which the exposition serves as a gauge.
        if scraped.name not in own and scraped.name.removesuffix("_created") not in own:
            continue
        series = set()
        for sample in scraped.samples:
            labels = dict(sample.labels)
            # Other tests share the registry: keep the series this test's requests made.
            if labels.get("method", "GET") != "GET":
                continue
            if "route" in labels and not (
                labels["route"].startswith("/golden-metrics/") or labels["route"] == "__unmatched__"
            ):
                continue
            if "service" in labels and labels["service"] != "golden-metrics-svc":
                continue
            if labels.get("route") == "__unmatched__" and labels.get("status") not in (None, "404"):
                continue
            series.add(json.dumps({"name": sample.name, "labels": labels}, sort_keys=True))
        families.append(
            {
                "name": scraped.name,
                "type": scraped.type,
                "series": [json.loads(s) for s in sorted(series)],
            }
        )
    return {
        "content_type": response.headers["content-type"],
        "families": sorted(families, key=lambda f: f["name"]),
    }


def build() -> dict[str, Any]:
    return {"registered": _registered(), "factories": _factories(), "exposition": _exposition()}


def test_metrics_match_golden() -> None:
    actual = json.loads(json.dumps(build()))
    assert actual == json.loads(GOLDEN.read_text())
