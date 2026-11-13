"""The connection pool a server builds its engine with, sized together with admission.

Every server that owns a database serves many workspaces from one pool per pod. The pool's
size and the per-workspace admission limit (:mod:`nimblebrain_server_sdk.db.admission`) are one
decision, so they are read, validated and held together in :class:`PoolSettings`:

  * ``pool_size`` / ``max_overflow`` — the connections the pool keeps open, and the ones it may
    open past that under load. Their sum is the most connections one pod holds.
  * ``pool_timeout_seconds`` — how long a checkout waits for a free connection before the pool
    gives up. A call that gives up here is refused as overloaded, having run nothing.
  * ``workspace_concurrency`` — how many calls one workspace may run at once on the pod.
  * ``workspace_wait_seconds`` — how long a call over that limit waits for a slot before it is
    refused as overloaded.

**The rule that ties them:** a call holds its session's connection, and at most one more for a
write it commits apart from its session (:data:`CONNECTIONS_PER_CALL`). So a workspace at its
limit holds at most ``CONNECTIONS_PER_CALL × workspace_concurrency`` connections, and that must
stay below the pool's total, or one workspace could hold every connection and every other
workspace's call would wait behind it. Settings that break the rule raise
:class:`PoolConfigError` on construction, which a server does at boot so a value that cannot
hold fails the rollout rather than a user's call.

Both waits sit well under the host's 60s tool budget, so an overloaded pod answers with a
refusal the agent can retry instead of a call the host abandons.

Each value is read from ``<PREFIX>_<NAME>`` (:meth:`PoolSettings.from_env`), the prefix being
the server's own env namespace. Unset, it takes the server's defaults, and those are the
conservative ones unless the server passes its own because its traffic needs more.

**The connection budget.** A pod holds at most ``pool_size + max_overflow`` connections, so the
worst case on one database is::

    sum over the servers using it of (pool_size + max_overflow) × (replicas + max_surge)

where ``max_surge`` is the extra pods a rolling update runs at once (one per server rolling).
That sum, plus whatever else connects to the database, must stay below its
``max_connections``. Raising a pool setting or a replica count spends that budget.
"""

from pgbulkhead.pool import (
    CONNECTIONS_PER_CALL,
    PoolConfigError,
    PoolSettings,
    create_pooled_engine,
)

__all__ = [
    "CONNECTIONS_PER_CALL",
    "PoolConfigError",
    "PoolSettings",
    "create_pooled_engine",
]
