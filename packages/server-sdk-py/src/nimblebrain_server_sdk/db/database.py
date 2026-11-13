"""One server's database: its pool settings, its pooled engine and its workspace limiter.

A server that owns a database declares one :class:`SecuredDatabase` per process::

    db = SecuredDatabase(url_env="NOTES_DATABASE_URL", prefix="NOTES")
    notes_session = db.session

and its lifespan calls :meth:`SecuredDatabase.check` and :meth:`SecuredDatabase.check_role`
once, before it serves. The object reads and validates the settings once, builds the engine
lazily on the first session (importing the server needs no database), and admits every
:meth:`~SecuredDatabase.session` against the workspace's concurrency limit before it checks a
connection out.

Its engine refuses every connection made as a superuser or ``BYPASSRLS`` role with
:class:`~nimblebrain_server_sdk.db.UnsafeRoleError`, because Postgres applies no row-level
security policy to one. ``refuse_bypass_roles=False`` turns that off, for a database object
that is meant to bypass (one that runs migrations or provisioning), never for one that serves
a request.
"""

from __future__ import annotations

from collections.abc import Callable
from contextlib import AbstractAsyncContextManager

import pgbulkhead
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from .pool import PoolSettings, create_pooled_engine
from .presets import NIMBLEBRAIN
from .session import secured_session, system_session

__all__ = ["SecuredDatabase"]


class SecuredDatabase(pgbulkhead.SecuredDatabase):
    """The settings, engine and limiter one server process uses for its own database.

    ``url_env`` names the env var holding the async Postgres URL (the app role, never a
    superuser). ``url`` replaces how the URL is read, for a server whose missing URL means
    something specific. ``prefix`` is the env namespace of the pool settings, and ``defaults``
    the server's own when its traffic needs more than the conservative defaults
    (:class:`PoolSettings`). ``refuse_bypass_roles`` (on by default) makes the engine refuse a
    superuser or ``BYPASSRLS`` role (:func:`create_pooled_engine`); turn it off only for a
    database object that is meant to bypass row-level security.
    """

    def __init__(
        self,
        *,
        url_env: str,
        prefix: str,
        defaults: PoolSettings | None = None,
        url: Callable[[], str] | None = None,
        refuse_bypass_roles: bool = True,
    ) -> None:
        super().__init__(
            model=NIMBLEBRAIN, prefix=prefix, url_env=url_env, url=url, defaults=defaults
        )
        self.refuse_bypass_roles = refuse_bypass_roles

    def get_engine(self) -> AsyncEngine:
        """The pooled engine, built on first use, refusing bypass roles unless told not to."""
        # pgbulkhead's own builder always refuses; this one passes the opt-out through. It
        # reads the base class's URL reader and engine slot, which the exact pin holds fixed.
        if self._engine is None:
            self._engine = create_pooled_engine(
                self._url(), self.settings, refuse_bypass_roles=self.refuse_bypass_roles
            )
        return self._engine

    def unadmitted_session(
        self, ctx: pgbulkhead.SecurityContext
    ) -> AbstractAsyncContextManager[AsyncConnection]:
        """An RLS session with no admission, for one opened while the request holds a slot."""
        return secured_session(self.get_engine(), ctx)

    def system_session(self) -> AbstractAsyncContextManager[AsyncConnection]:  # ty: ignore[invalid-method-override]
        """A ``system``-role session (reconcilers, admin); not admitted, never per workspace."""
        return system_session(self.get_engine())
