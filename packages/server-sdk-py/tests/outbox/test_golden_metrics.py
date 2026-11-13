"""Golden: the domain metric families notify-outbox declares.

Every family this library's own modules register through the observability library's
metric factories, by name, type, label names and, for a histogram, bucket bounds: what alert
rules and dashboards query. A rename or a dropped label is a silent break for them.

``tests/golden/metrics.json`` is frozen output with no regenerate path.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from prometheus_client.metrics import MetricWrapperBase

# The registry these families are served from: only this line names the library.
from nimblebrain_server_sdk.observability.metrics import REGISTRY
from nimblebrain_server_sdk.outbox import metrics

GOLDEN = Path(__file__).parent / "golden" / "metrics.json"

#: The modules that declare this library's metrics.
DECLARING = (metrics,)


def _family(metric: MetricWrapperBase) -> dict[str, Any]:
    out: dict[str, Any] = {
        "name": metric._name,
        "type": metric._type,
        "labels": list(metric._labelnames),
    }
    if metric._type == "histogram":
        out["buckets"] = [str(bound) for bound in metric._upper_bounds]  # ty: ignore[unresolved-attribute]
    return out


def declared() -> list[dict[str, Any]]:
    found = {
        id(obj): obj
        for module in DECLARING
        for obj in vars(module).values()
        if isinstance(obj, MetricWrapperBase)
    }
    return sorted((_family(metric) for metric in found.values()), key=lambda f: f["name"])


def test_declared_metrics_match_golden() -> None:
    assert json.loads(json.dumps(declared())) == json.loads(GOLDEN.read_text())


def test_declared_metrics_are_served_from_the_shared_registry() -> None:
    served = {family.name for family in REGISTRY.collect()}
    assert {f["name"] for f in declared()} <= served
