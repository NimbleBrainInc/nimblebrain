"""A database error reaches the log line and the exported span without the row it was about.

Postgres writes the offending values into its own message (``DETAIL:  Key (email)=(...)``),
and SQLAlchemy appends the statement's bound parameters, so a traceback rendered whole puts a
person's email in the logs. These run real Postgres errors through the real renderer and
exporter and read what comes out: the canary must be absent, and what an operator needs
(SQLSTATE, constraint, table, column, the log line's frames) present.

The engine here (``pg_admin``) is built without ``hide_parameters``, so the parameters are in
the exception's text and only the renderer stands between them and the line.
"""

from __future__ import annotations

import io
import json
import logging
import uuid
from collections.abc import Iterator

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Status, StatusCode
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine

from nimblebrain_server_sdk.db import SecuredDatabase
from nimblebrain_server_sdk.observability import configure_logging, get_logger
from nimblebrain_server_sdk.observability.tracing import RedactingSpanExporter


def _canary() -> str:
    """A value no source line contains, so finding it in a line means it leaked."""
    return f"jane.{uuid.uuid4().hex[:12]}@acme.example"


async def _fail(engine: AsyncEngine, setup: str, statement: str, value: str) -> DBAPIError:
    """Run ``statement`` with ``value`` bound after ``setup``; return the error it raises."""
    async with engine.connect() as conn:
        for part in setup.split(";"):
            await conn.execute(text(part))
        try:
            await conn.execute(text(statement), {"v": value})
        except DBAPIError as exc:
            await conn.rollback()
            return exc
    pytest.fail("the statement did not fail")


UNIQUE = (
    "CREATE TEMP TABLE people_u (email text CONSTRAINT people_u_email_key UNIQUE);"
    "INSERT INTO people_u VALUES ('seed')",
    "INSERT INTO people_u SELECT :v FROM generate_series(1, 2)",
    {"sqlstate": "23505", "constraint": "people_u_email_key", "table": "people_u"},
)
NOT_NULL = (
    "CREATE TEMP TABLE people_n (email text, phone text NOT NULL)",
    "INSERT INTO people_n (email, phone) VALUES (:v, NULL)",
    {"sqlstate": "23502", "column": "phone", "table": "people_n"},
)
CHECK = (
    "CREATE TEMP TABLE people_c (email text CONSTRAINT people_c_email_short CHECK (length(email) < 5))",
    "INSERT INTO people_c VALUES (:v)",
    {"sqlstate": "23514", "constraint": "people_c_email_short", "table": "people_c"},
)
CASES = pytest.mark.parametrize(
    ("setup", "statement", "fields"), [UNIQUE, NOT_NULL, CHECK], ids=["unique", "not_null", "check"]
)


@pytest.fixture
def lines() -> Iterator[io.StringIO]:
    """The JSON lines the configured root handler writes while the test runs."""
    configure_logging("redaction-svc")
    handler = logging.getLogger().handlers[0]
    buffer = io.StringIO()
    original, handler.stream = handler.stream, buffer  # ty: ignore[unresolved-attribute]
    try:
        yield buffer
    finally:
        handler.stream = original  # ty: ignore[unresolved-attribute]


def _only_line(buffer: io.StringIO) -> tuple[str, dict]:
    (raw,) = buffer.getvalue().strip().splitlines()
    return raw, json.loads(raw)


async def test_the_unredacted_error_carries_the_canary(pg_admin: AsyncEngine) -> None:
    """The premise: without the renderer, the value is in the exception's text twice over."""
    value = _canary()
    exc = await _fail(pg_admin, *UNIQUE[:2], value)
    assert value in str(exc)  # SQLAlchemy's [parameters: ...]
    assert exc.orig is not None
    assert value in str(exc.orig.__cause__)  # Postgres's DETAIL, on asyncpg's own error


@CASES
async def test_a_structlog_line_carries_no_value(
    pg_admin: AsyncEngine, lines: io.StringIO, setup: str, statement: str, fields: dict
) -> None:
    value = _canary()
    exc = await _fail(pg_admin, setup, statement, value)
    try:
        raise exc
    except DBAPIError:
        get_logger("svc.db").exception("session_commit_failed")

    raw, line = _only_line(lines)
    assert value not in raw
    assert "DETAIL" not in raw
    assert "[parameters" not in raw
    assert "INSERT" not in line["exception"].split("Traceback")[-1].splitlines()[-1]
    assert line["db_error"].items() >= fields.items()
    assert "sqlalchemy.exc.IntegrityError" in line["exception"]
    assert 'File "' in line["exception"]
    assert line["event"] == "session_commit_failed"


@CASES
async def test_a_stdlib_line_with_exc_info_carries_no_value(
    pg_admin: AsyncEngine, lines: io.StringIO, setup: str, statement: str, fields: dict
) -> None:
    """The fleet's ``logger.error("...", exc_info=exc)``, through the foreign-record chain."""
    value = _canary()
    exc = await _fail(pg_admin, setup, statement, value)
    logging.getLogger("svc.db").error("session_commit_failed", exc_info=exc)

    raw, line = _only_line(lines)
    assert value not in raw
    assert line["db_error"].items() >= fields.items()
    assert f"sqlstate={fields['sqlstate']}" in line["exception"]


async def test_a_wrapper_that_embeds_the_message_is_withheld_too(
    pg_admin: AsyncEngine, lines: io.StringIO
) -> None:
    value = _canary()
    exc = await _fail(pg_admin, *UNIQUE[:2], value)
    try:
        raise RuntimeError(f"insert failed: {exc}") from exc
    except RuntimeError:
        get_logger("svc.db").exception("insert_failed")

    raw, line = _only_line(lines)
    assert value not in raw
    assert "RuntimeError: [message withheld" in line["exception"]
    assert "direct cause" in line["exception"]
    assert line["db_error"]["constraint"] == "people_u_email_key"


def test_any_other_exception_is_rendered_whole(lines: io.StringIO) -> None:
    try:
        raise ValueError("an ordinary message")
    except ValueError:
        get_logger("svc").exception("ordinary_failure")

    _, line = _only_line(lines)
    assert "ValueError: an ordinary message" in line["exception"]
    assert "db_error" not in line


async def test_an_exported_span_carries_no_value(pg_admin: AsyncEngine) -> None:
    """FastMCP records the exception on its span and sets the status to ``str(exc)``."""
    value = _canary()
    exc = await _fail(pg_admin, *UNIQUE[:2], value)
    exported = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(RedactingSpanExporter(exported)))
    with provider.get_tracer("t").start_as_current_span("tools/call", record_exception=False) as s:
        s.record_exception(exc)
        s.set_status(Status(StatusCode.ERROR, str(exc)))

    (span,) = exported.get_finished_spans()
    assert value not in json.dumps(span.to_json())
    (event,) = span.events
    assert event.attributes is not None
    assert event.attributes["exception.type"] == "sqlalchemy.exc.IntegrityError"
    assert "Traceback" not in str(event.attributes["exception.stacktrace"])
    assert span.status.status_code is StatusCode.ERROR


def test_a_span_without_a_database_error_is_exported_as_recorded() -> None:
    exported = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(RedactingSpanExporter(exported)))
    with provider.get_tracer("t").start_as_current_span("tools/call", record_exception=False) as s:
        s.record_exception(ValueError("an ordinary message"))

    (span,) = exported.get_finished_spans()
    assert span.events[0].attributes is not None
    assert span.events[0].attributes["exception.message"] == "an ordinary message"


async def test_secured_database_errors_carry_no_parameters(pg_admin_url: str) -> None:
    """``SecuredDatabase``'s engine hides bound values, so ``str(exc)`` lacks them anywhere."""
    db = SecuredDatabase(
        url_env="UNUSED_DATABASE_URL",
        prefix="REDACT",
        url=lambda: pg_admin_url,
        refuse_bypass_roles=False,
    )
    try:
        value = _canary()
        exc = await _fail(db.get_engine(), *UNIQUE[:2], value)
        assert "parameters hidden" in str(exc)
        assert value not in str(exc)
    finally:
        await db.dispose()
