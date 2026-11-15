"""The metrics endpoint serves the request metrics and the server's own counter."""

from observable_server import app
from starlette.testclient import TestClient


def test_metrics_are_served_in_prometheus_text() -> None:
    with TestClient(app) as client:
        response = client.get("/metrics")
    assert response.status_code == 200
    assert "notes_added_total" in response.text
    assert "http_requests_total" in response.text
