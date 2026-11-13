"""What ``configure_logging`` must hold at the rendered line.

Two properties, and both are about what a line MAY NOT say as much as what it must: httpx's
request URLs (and any query-param key) never reach the logs, and a caller's ``extra`` reaches
them without being able to overwrite an identity the edge verified and bound.
"""

from __future__ import annotations

import logging

import pytest

from nimblebrain_server_sdk.observability.logging import configure_logging


class _Capture(logging.Handler):
    """Collects the records dispatched to it, for asserting what a logger emits."""

    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


URL_LOGGING_CLIENTS = ["httpx", "httpcore", "httpx2", "httpcore2"]


@pytest.mark.parametrize("name", URL_LOGGING_CLIENTS)
def test_configure_logging_pins_the_http_client_loggers_to_warning(name: str) -> None:
    configure_logging("test-svc")
    assert logging.getLogger(name).level == logging.WARNING


@pytest.mark.parametrize("name", ["httpx", "httpx2"])
def test_httpx_info_request_line_is_dropped(name: str) -> None:
    """Prove an httpx INFO request line (which carries the full URL, and for some
    providers the api_key) is suppressed after configure_logging.

    caplog can't be used here: configure_logging does ``root.handlers = [handler]``,
    which evicts caplog's capture handler, so caplog.records is always empty and the
    assertion would pass vacuously. Instead attach a handler to the httpx logger
    itself (configure_logging only resets the ROOT handlers, so this survives). httpx
    at WARNING filters the INFO record at the logger, so nothing is dispatched to the
    handler; the handler fires ONLY if httpx is left at INFO (the pin gone), so an
    empty capture proves the drop and removing the pin makes this fail.
    """
    configure_logging("test-svc")
    capture = _Capture()
    httpx_logger = logging.getLogger(name)
    httpx_logger.addHandler(capture)
    try:
        httpx_logger.info(
            "HTTP Request: GET https://api.example.test/v2/x?api_key=SECRETVALUE 200 OK"
        )
    finally:
        httpx_logger.removeHandler(capture)
    assert not any("SECRETVALUE" in record.getMessage() for record in capture.records)


def _rendered(logger_name: str, event: str, **extra: object) -> dict[str, object]:
    """One rendered JSON line, through the real handler servers ship with.

    Asserting on the RECORD would prove nothing: ``extra`` always lands on the record.
    The defect was in the FORMATTER, so the line is the only thing worth reading.
    """
    import io
    import json

    handler = logging.getLogger().handlers[0]
    buffer = io.StringIO()
    original, handler.stream = handler.stream, buffer  # ty: ignore[unresolved-attribute]
    try:
        logging.getLogger(logger_name).warning(event, extra=extra)
    finally:
        handler.stream = original  # ty: ignore[unresolved-attribute]
    return json.loads(buffer.getvalue().strip())


def test_a_stdlib_extra_field_reaches_the_rendered_line() -> None:
    """``extra={...}`` is the stdlib idiom, and without ``ExtraAdder`` the formatter drops it
    silently — the line is emitted, the field is not, and nothing errors.

    That is worse than a missing log: the code reads as though it worked, so a field written
    to be selected on (``| json | workspace_ref=...``) is absent exactly when someone needs
    it, and the absence looks like the event never happened.
    """
    configure_logging("test-svc")
    line = _rendered("svc.module", "something_happened", workspace_ref="ws-abc", count=3)

    assert line["workspace_ref"] == "ws-abc"
    assert line["count"] == 3
    assert line["event"] == "something_happened"


def test_a_stamped_field_is_not_lost_to_the_extra_merge() -> None:
    """The merge runs first, so the stamps that follow it must still land on every line."""
    configure_logging("test-svc")
    line = _rendered("svc.module", "something_happened", workspace_ref="ws-abc")

    assert line["service"] == "test-svc"
    assert line["level"] == "warning"
    assert "timestamp" in line


def test_a_caller_cannot_overwrite_the_identity_the_edge_verified() -> None:
    """The precedence the ordering exists for.

    ``tenant_id`` / ``workspace_id`` / ``caller`` are bound from verified edge headers and
    never from a caller. A log line is where that binding is read back, so an ``extra`` key
    of the same name must not be able to make a line claim a tenant the request did not
    carry — which is what an ``ExtraAdder`` running last would allow.

    The scope is a BOUND field: ``_inject_context`` restores what ``current_context()``
    reports, and that omits anything unset, so this is the case where there is a verified
    value to restore.
    """
    from nimblebrain_server_sdk.observability.context import bind_context, clear_context

    configure_logging("real-svc")
    bind_context(tenant_id="tenant-real", workspace_id="ws-real", caller="edge")
    try:
        line = _rendered(
            "svc.module",
            "real_event",
            tenant_id="forged",
            workspace_id="forged",
            caller="forged",
            ok_field="kept",
        )
    finally:
        clear_context()

    assert line["tenant_id"] == "tenant-real"
    assert line["workspace_id"] == "ws-real"
    assert line["caller"] == "edge"
    # And the caller's own field still arrives — the point of the change.
    assert line["ok_field"] == "kept"


def test_a_second_configure_keeps_the_chain_a_cached_logger_holds() -> None:
    """The structlog chain is the process's, so a later ``configure_logging`` must not swap it.

    ``cache_logger_on_first_use`` makes a logger keep the processor list it first ran with.
    Replacing that list on a second call (a second app instrumented in the same process, as a
    test that builds another service's app does) leaves every logger already used on the old
    one: its lines no longer reach what reads the current chain, ``capture_logs`` included,
    while metrics still count the event, so the two disagree with nothing reporting why.
    """
    import structlog
    from structlog.testing import capture_logs

    configure_logging("first-svc")
    logger = structlog.stdlib.get_logger("svc.cached")
    logger.info("warm")  # caches the logger on the chain in force now

    configure_logging("second-svc")
    with capture_logs() as logs:
        logger.info("after_reconfigure")

    assert [entry["event"] for entry in logs] == ["after_reconfigure"]
