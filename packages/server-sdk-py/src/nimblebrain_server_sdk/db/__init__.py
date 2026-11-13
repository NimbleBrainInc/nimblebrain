"""Tenant + workspace data access for a server that owns a Postgres database.

Needs the ``[db]`` extra (``pip install 'nimblebrain-server-sdk[db]'``); imported without it,
this package raises an ``ImportError`` that names the extra.

The pattern, in three pieces:

  * ``SecurityContext`` — the verified request identity, built ONLY from a
    verified token's claims (never a request body), or for a server behind
    the edge from the verified headers the edge injects
    (``security_context_from_edge_headers``). Tenant is the hard wall;
    workspace is the soft wall inside a tenant.
  * ``secured_session`` — opens a transaction with that context bound as
    Postgres GUCs (``SET LOCAL`` semantics), so every query runs under RLS
    scoped to (tenant, workspace, allowed_workspaces). Transaction-scoped, so a
    pooled connection cannot leak context to the next request. Its exit is
    shielded from cancellation, so a cancelled call returns its connection.
  * ``rls_policy_sql`` — the standard RLS policy a service applies to every
    table tagged ``(tenant_id, workspace_id)``.

And the capacity around them, for a server that serves many workspaces from one pool:

  * ``SecuredDatabase`` — the one object a server declares for its database: settings read
    and validated once (``check()`` in the lifespan), a lazily built pooled engine, the
    workspace limiter, admitted ``session(ctx)`` and ``admitted(ctx)`` for several sessions
    under one slot.
  * ``PoolSettings`` / ``create_pooled_engine`` — the pool's size and timeout, read from the
    server's env namespace and validated together with the admission limit at boot. The engine
    refuses a superuser or ``BYPASSRLS`` role with ``UnsafeRoleError`` unless built with
    ``refuse_bypass_roles=False`` (an engine meant to bypass, such as a migration's).
  * ``WorkspaceLimiter`` — at most N calls per workspace at once,
    admitted before a call checks out a connection; a call refused for capacity raises
    ``Overloaded``, which a server returns as ``rate_limited``.

The generic core is the public ``pgbulkhead`` package; this package is NimbleBrain's
configuration of it (``presets``), its edge identity (``edge``), and the names servers import.
"""

from nimblebrain_server_sdk._extras import require_extra

require_extra("nimblebrain_server_sdk.db", "db", ("pgbulkhead", "sqlalchemy.ext.asyncio"))

from .admission import (  # noqa: E402
    AdmittedSlot,
    Overloaded,
    PoolExhausted,
    WorkspaceBusy,
    WorkspaceLimiter,
)
from .context import SecurityContext  # noqa: E402
from .database import SecuredDatabase  # noqa: E402
from .edge import (  # noqa: E402
    TENANT_HEADER,
    WORKSPACE_HEADER,
    AuthError,
    security_context_from_edge_headers,
)
from .pool import (  # noqa: E402
    CONNECTIONS_PER_CALL,
    PoolConfigError,
    PoolSettings,
    UnsafeRoleError,
    create_pooled_engine,
)
from .rls import (  # noqa: E402
    rls_policy_sql,
    rls_policy_sql_org_scoped,
    rls_policy_sql_tenant_scoped,
)
from .session import (  # noqa: E402
    CLEANUP_TIMEOUT_SECONDS,
    org_session,
    secured_session,
    system_session,
)

__all__ = [
    "CLEANUP_TIMEOUT_SECONDS",
    "CONNECTIONS_PER_CALL",
    "TENANT_HEADER",
    "WORKSPACE_HEADER",
    "AdmittedSlot",
    "AuthError",
    "Overloaded",
    "PoolConfigError",
    "PoolExhausted",
    "PoolSettings",
    "SecuredDatabase",
    "SecurityContext",
    "UnsafeRoleError",
    "WorkspaceBusy",
    "WorkspaceLimiter",
    "create_pooled_engine",
    "org_session",
    "rls_policy_sql",
    "rls_policy_sql_org_scoped",
    "rls_policy_sql_tenant_scoped",
    "secured_session",
    "security_context_from_edge_headers",
    "system_session",
]
