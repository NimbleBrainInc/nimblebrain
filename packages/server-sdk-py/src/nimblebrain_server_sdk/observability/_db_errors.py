"""Database errors rendered without their messages, for the log line and the exported span.

A database error's message carries row data. Postgres writes the conflicting values into its
own text (``DETAIL:  Key (email)=(...) already exists.``), the driver passes that text on, and
SQLAlchemy appends the statement and its bound parameters to it. No engine setting removes
the first, so the message itself never reaches a log line or a span: what does is the
exception's class, the fields a driver exposes as attributes that name the schema rather than
the data (SQLSTATE, constraint, table, column, schema, data type), and the traceback's frames.

When any exception in a chain (its ``__cause__`` / ``__context__``, and the members of an
exception group) is a database error, every message in the chain is withheld, because a
wrapper's message routinely embeds the error it wraps (``RuntimeError(f"insert failed: {e}")``,
and SQLAlchemy's own wrappers).

A database error is an exception whose class, or a base of it, is defined in a database
driver or SQLAlchemy. That is read from the class's module name, so this module imports
neither, and the ``[observability]`` extra never requires them.
"""

from __future__ import annotations

import re
import traceback
from collections.abc import Iterator, Mapping, MutableMapping
from typing import Any

#: The top-level packages whose exceptions are database errors: the Postgres drivers and
#: SQLAlchemy (whose messages embed the driver's, plus the SQL and its parameters).
DATABASE_PACKAGES = frozenset({"asyncpg", "psycopg", "psycopg2", "pg8000", "sqlalchemy"})

#: What replaces a withheld message.
WITHHELD = "[message withheld: database error]"

#: The attributes copied from a database error, under the name the log line uses. Each names
#: a part of the schema or an error class, never a value.
_FIELDS = {
    "sqlstate": ("sqlstate", "pgcode"),
    "constraint": ("constraint_name",),
    "table": ("table_name",),
    "column": ("column_name",),
    "schema": ("schema_name",),
    "data_type": ("data_type_name", "datatype_name"),
}

#: A Postgres SQLSTATE: five characters, digits and uppercase letters.
_SQLSTATE = re.compile(r"^[0-9A-Z]{5}$")


def is_database_error(exc: BaseException) -> bool:
    """Whether ``exc``'s class, or one of its bases, is defined in a database package."""
    return any(cls.__module__.partition(".")[0] in DATABASE_PACKAGES for cls in type(exc).__mro__)


def _chain(exc: BaseException) -> Iterator[BaseException]:
    """``exc`` and every exception linked to it, each once."""
    seen: set[int] = set()
    stack = [exc]
    while stack:
        current = stack.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        yield current
        stack.extend(e for e in (current.__cause__, current.__context__) if e is not None)
        if isinstance(current, BaseExceptionGroup):
            stack.extend(current.exceptions)


def involves_database_error(exc: BaseException) -> bool:
    """Whether ``exc`` or any exception linked to it is a database error."""
    return any(is_database_error(e) for e in _chain(exc))


def _fields_of(exc: BaseException) -> dict[str, str]:
    """The schema-naming attributes ``exc`` exposes, as the log line names them."""
    sources: list[object] = [exc]
    diag = getattr(exc, "diag", None)  # psycopg keeps them on a diagnostics object
    if diag is not None:
        sources.append(diag)
    found: dict[str, str] = {}
    for field, names in _FIELDS.items():
        for source in sources:
            for name in names:
                value = getattr(source, name, None)
                if isinstance(value, str) and value and field not in found:
                    found[field] = value
    sqlstate = found.get("sqlstate")
    if sqlstate is not None and not _SQLSTATE.match(sqlstate):
        del found["sqlstate"]
    return found


def database_error_fields(exc: BaseException) -> dict[str, str]:
    """The schema-naming fields of the database errors linked to ``exc``, first found wins."""
    merged: dict[str, str] = {}
    for linked in _chain(exc):
        if is_database_error(linked):
            for field, value in _fields_of(linked).items():
                merged.setdefault(field, value)
    return merged


def _type_name(exc: BaseException) -> str:
    cls = type(exc)
    module = cls.__module__
    return cls.__qualname__ if module == "builtins" else f"{module}.{cls.__qualname__}"


def _header(exc: BaseException) -> str:
    """``module.Class: <withheld> sqlstate=... constraint=...``, the line a message would be."""
    fields = _fields_of(exc) if is_database_error(exc) else {}
    detail = "".join(f" {field}={value}" for field, value in fields.items())
    return f"{_type_name(exc)}: {WITHHELD}{detail}\n"


def _render(exc: BaseException, seen: set[int]) -> list[str]:
    """``exc``'s traceback as ``traceback.format_exception`` lays it out, minus every message."""
    seen.add(id(exc))
    lines: list[str] = []
    cause, context = exc.__cause__, exc.__context__
    if cause is not None and id(cause) not in seen:
        lines += _render(cause, seen)
        lines.append("\nThe above exception was the direct cause of the following exception:\n\n")
    elif context is not None and not exc.__suppress_context__ and id(context) not in seen:
        lines += _render(context, seen)
        lines.append("\nDuring handling of the above exception, another exception occurred:\n\n")
    if exc.__traceback__ is not None:
        lines.append("Traceback (most recent call last):\n")
        lines += traceback.format_tb(exc.__traceback__)
    lines.append(_header(exc))
    if isinstance(exc, BaseExceptionGroup):
        for number, member in enumerate(exc.exceptions, 1):
            if id(member) in seen:
                continue
            lines.append(f"+---------------- {number} ----------------\n")
            lines += _render(member, seen)
    return lines


def render_without_messages(exc: BaseException) -> str:
    """``exc``'s traceback: every frame and class, no exception's message or notes."""
    return "".join(_render(exc, set())).rstrip("\n")


def _logged_exception(exc_info: Any) -> BaseException | None:
    """The exception an ``exc_info`` value names, read as structlog's ``format_exc_info`` does."""
    if isinstance(exc_info, BaseException):
        return exc_info
    if isinstance(exc_info, tuple):
        return exc_info[1] if len(exc_info) == 3 else None
    if exc_info:
        import sys

        return sys.exc_info()[1]
    return None


def redact_database_errors(
    _logger: Any, _method: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """structlog processor: render a database error's traceback with no message in it.

    Runs before ``format_exc_info``. When the logged exception involves a database error it
    takes ``exc_info`` off the event and writes ``exception`` itself, every message withheld,
    and adds ``db_error``: the SQLSTATE and the constraint, table, column and schema the
    driver reported. Any other exception is left to ``format_exc_info`` unchanged.
    """
    exc = _logged_exception(event_dict.get("exc_info"))
    if exc is None or not involves_database_error(exc):
        return event_dict
    del event_dict["exc_info"]
    event_dict["exception"] = render_without_messages(exc)
    fields = database_error_fields(exc)
    if fields:
        event_dict["db_error"] = fields
    return event_dict


# --- Spans --------------------------------------------------------------------------------
#
# A span records an exception as an event (``exception.type``, ``exception.message``,
# ``exception.stacktrace``) and FastMCP also puts ``str(exc)`` in the span's status. By export
# the exception object is gone, so a database error is recognised from the text: the event's
# type, or a header line of the stacktrace, names a class in a database package. A header
# inside an exception group carries the group's ``|`` margin, so the margin is allowed.

_DATABASE_HEADER = re.compile(
    r"^[ |]*(?:" + "|".join(sorted(DATABASE_PACKAGES)) + r")(?:\.\w+)*(?::|$)", re.MULTILINE
)


def _names_database_error(attributes: Mapping[str, Any]) -> bool:
    exc_type = attributes.get("exception.type")
    if isinstance(exc_type, str) and exc_type.partition(".")[0] in DATABASE_PACKAGES:
        return True
    stacktrace = attributes.get("exception.stacktrace")
    return isinstance(stacktrace, str) and _DATABASE_HEADER.search(stacktrace) is not None


def redact_exception_event(attributes: Mapping[str, Any]) -> dict[str, Any] | None:
    """An exception event's attributes with the message withheld, or ``None`` to keep them.

    The stacktrace is reduced to the exception's type: once it is a string, a message line can
    imitate a ``File "...", line N, in f`` frame exactly, so no line of it is kept. The frames
    stay on the log line, which renders them from the exception object.
    """
    if not _names_database_error(attributes):
        return None
    redacted = dict(attributes)
    redacted["exception.message"] = WITHHELD
    if "exception.stacktrace" in attributes:
        redacted["exception.stacktrace"] = f"{attributes.get('exception.type', '')}: {WITHHELD}"
    return redacted
