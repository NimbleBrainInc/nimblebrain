"""The server half of the notification contract.

Needs the ``[outbox]`` extra (``pip install 'nimblebrain-server-sdk[outbox]'``), which installs
``[db]`` and ``[observability]``; imported without it, this package raises an ``ImportError``
that names the extra.

A server that learns something asynchronously — a domain it ordered went
active, a reply landed — has nowhere to put the fact: nobody is calling it, and
it must not grow a Slack client, learn a host's address, or assert a workspace
identity of its own. So it **records**, and something else moves and routes.

This is the recording half, and it is three things:

  * :func:`outbox_table` / :func:`outbox_ddl` — a table beside the server's own,
    under the same ``nimblebrain_server_sdk.db`` RLS policy, so an outbox row is scoped by the
    same wall as a business row.
  * :func:`emit` — an append inside the transaction that made the fact true.
  * :func:`read` — the poll a host answers with, carrying the one property the
    design depends on: a poll never skips a row that was in flight when it ran
    (:mod:`nimblebrain_server_sdk.outbox.core` explains how).

:func:`register_outbox` serves that poll as one MCP resource. It is a separate
module because the core has no MCP dependency and should not gain one.

Adoption is ten lines; the README has them.
"""

from nimblebrain_server_sdk._extras import require_extra

# Before the imports below: each of them imports ``db`` or ``observability``, whose own guards
# would name ``[db]`` or ``[observability]`` rather than the extra this package is installed by.
require_extra(
    "nimblebrain_server_sdk.outbox",
    "outbox",
    (
        "pgbulkhead",
        "sqlalchemy.ext.asyncio",
        "prometheus_client",
        "structlog",
        "opentelemetry.sdk.trace",
    ),
)

from .core import (  # noqa: E402
    DEFAULT_MAX_EVENTS,
    DEFAULT_MAX_ROWS,
    DEFAULT_TABLE_NAME,
    MAX_AGE_MS_CEILING,
    MAX_MAX_EVENTS,
    RETENTION,
    emit,
    outbox_ddl,
    outbox_table,
    read,
)
from .cursor import MAX_CURSOR_LENGTH, CursorError  # noqa: E402
from .envelope import (  # noqa: E402
    BODY_MAX,
    DEFAULT_LEVEL,
    ENVELOPE_MAX_BYTES,
    LEVELS,
    NOTIFICATION_META_KEY,
    SUBJECT_MAX,
    TITLE_MAX,
    EnvelopeError,
)
from .fastmcp import register_outbox  # noqa: E402

__all__ = [
    "BODY_MAX",
    "DEFAULT_LEVEL",
    "DEFAULT_MAX_EVENTS",
    "DEFAULT_MAX_ROWS",
    "DEFAULT_TABLE_NAME",
    "ENVELOPE_MAX_BYTES",
    "LEVELS",
    "MAX_AGE_MS_CEILING",
    "MAX_CURSOR_LENGTH",
    "MAX_MAX_EVENTS",
    "NOTIFICATION_META_KEY",
    "RETENTION",
    "SUBJECT_MAX",
    "TITLE_MAX",
    "CursorError",
    "EnvelopeError",
    "emit",
    "outbox_ddl",
    "outbox_table",
    "read",
    "register_outbox",
]
