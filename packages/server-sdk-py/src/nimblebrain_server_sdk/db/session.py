"""Request-scoped sessions that bind the security context for RLS.

The discipline that makes this safe under connection pooling: the context is set
with ``set_config(..., is_local => true)`` **inside a transaction**, so it is
scoped to that transaction and reset on commit/rollback. A pooled connection can
never carry one request's tenant/workspace into the next. The values are bound
as parameters, never string-interpolated — no GUC injection.

This is the single chokepoint every shared service uses, so the pooling
discipline is enforced once here, not re-implemented (and mis-implemented) per
service.

**The exit is cancel-safe.** An MCP call runs under an anyio cancel scope, and a
scope's cancellation is level-triggered: once the scope is cancelled, every await
inside it raises again. A session left by cancellation (a client that hung up, a
host timeout) would otherwise have its rollback cancelled too, and SQLAlchemy then
terminates the connection rather than return it, so every cancelled call costs the
pool a connection and logs ``Exception terminating connection``. Each session here
therefore ends its transaction and returns its connection inside a shielded scope.
Each cleanup step is bounded by :data:`CLEANUP_TIMEOUT_SECONDS` (the commit or rollback, then
the return), so a cancelled call's exit takes at most about twice that, and a database that
stops answering cannot hold it forever: past the bound, a rollback or the
return is abandoned and SQLAlchemy discards the connection, as it would without the
shield, and a commit raises ``TimeoutError``.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import pgbulkhead
from pgbulkhead import CLEANUP_TIMEOUT_SECONDS, bind_context, transaction
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from .presets import NIMBLEBRAIN, ORG_SCOPED

__all__ = ["CLEANUP_TIMEOUT_SECONDS", "org_session", "secured_session", "system_session"]


@asynccontextmanager
async def secured_session(
    engine: AsyncEngine, ctx: pgbulkhead.SecurityContext
) -> AsyncGenerator[AsyncConnection]:
    """A transaction with ``ctx`` bound. Every query inside runs under RLS scoped
    to (tenant, workspace, allowed_workspaces). Default-deny: if a policy can't
    match the context, it returns nothing.

    Raises ``ValueError``, before opening anything, for a context that cannot be bound
    faithfully: an empty tenant or workspace, or an empty or comma-bearing workspace, read
    grant or scope. The read grants and scopes are bound comma-joined and the policy splits
    them again, so a comma inside one value would split it into several and widen what the
    session may read (``pgbulkhead.check_context``)."""
    async with pgbulkhead.scoped_session(engine, NIMBLEBRAIN, ctx) as conn:
        yield conn


@asynccontextmanager
async def system_session(engine: AsyncEngine) -> AsyncGenerator[AsyncConnection]:
    """Cross-cutting access for reconcilers / admin jobs. Bypasses *workspace*
    scoping via the ``system`` role flag — never the tenant wall. Use sparingly
    and AUDIT every use (actor='system')."""
    async with pgbulkhead.system_session(engine, NIMBLEBRAIN) as conn:
        yield conn


@asynccontextmanager
async def org_session(engine: AsyncEngine, org_id: str) -> AsyncGenerator[AsyncConnection]:
    """A transaction scoped to one identity-provider **organization** by RLS.

    The single-key counterpart to :func:`secured_session`, for a service whose
    hard wall is an ``org_id`` rather than the platform's ``tenant_id`` — see
    :func:`~nimblebrain_server_sdk.db.rls.rls_policy_sql_org_scoped` for why those
    are different things and must not be read as peers.

    The discipline is identical and is the whole reason this lives here rather
    than in the adopting service: ``set_config(..., is_local => true)`` **inside**
    a transaction, so the binding dies on commit/rollback and a pooled connection
    can never carry one request's organization into the next. The value is a
    bound parameter, never interpolated. Getting either of those wrong fails
    SILENTLY and leaks across the wall, which is why there is one copy of it.

    ``org_id`` MUST come from something the caller verified — a resolved link row
    or a validated token — never from a vendor payload or a request body. Passing
    a falsy value is refused rather than binding an empty GUC that would match no
    row: an unscoped read should be an explicit act, not a typo that looks like
    an empty result.
    """
    if not org_id:
        raise ValueError("org_session requires a non-empty, verified org_id")
    async with transaction(engine) as conn:
        await bind_context(conn, ORG_SCOPED, pgbulkhead.SecurityContext(tenant_id=org_id))
        yield conn
