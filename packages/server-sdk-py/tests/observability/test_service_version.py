"""``service_version()`` reports SERVICE_VERSION, falling back to ``"dev"``.

The fallback is the non-obvious branch: an *empty* SERVICE_VERSION (an unset
deployment value rendering ``""``) must become ``"dev"``, which is why the
implementation uses ``or "dev"`` rather than ``os.environ.get(k, "dev")`` (the
latter would surface a blank version). These pin that against a future
"simplification."
"""

from __future__ import annotations

import pytest

from nimblebrain_server_sdk.observability import service_version


def test_reports_injected_version(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SERVICE_VERSION", "0.2.0")
    assert service_version() == "0.2.0"


def test_falls_back_to_dev_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SERVICE_VERSION", raising=False)
    assert service_version() == "dev"


def test_empty_is_treated_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SERVICE_VERSION", "")
    assert service_version() == "dev"
