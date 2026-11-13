"""Per-workspace admission: no one workspace can take every pooled connection on a pod.

Every call takes a pooled connection for its session, and the pool is shared by every
workspace the pod serves. Without a limit, one client that fires a burst of calls holds the
whole pool, and every other workspace's call waits behind it. :class:`WorkspaceLimiter` admits
at most ``limit`` calls per workspace at once, *before* the call checks a connection out, so a
burst queues behind its own workspace's slots while other workspaces keep theirs.

The key is the verified ``(tenant_id, workspace_id)`` of the call's :class:`SecurityContext`,
which a server builds from the edge headers alone; nothing a caller passes can choose it.

A call over the limit waits up to ``wait_seconds`` for a slot, then is refused with
:class:`WorkspaceBusy`. An admitted call whose checkout then waits past the pool's timeout is
refused with :class:`PoolExhausted`. Both are :class:`Overloaded`: the call ran nothing, so
retrying it is safe, and each server maps it onto its own error surface as ``rate_limited``.

State is bounded by the calls in flight: a workspace's entry exists only while some call holds
or waits for one of its slots, and is dropped when the last one leaves.

Admit only the call's own session (:func:`admitted_session`). A write a call commits apart
from its session opens a second session while the call already holds a slot; admitting that
one too could deadlock a workspace whose every slot is held by a call waiting for its second
session. A request that runs several sessions one after another holds one slot across them
all (:class:`AdmittedSlot`, from :meth:`SecuredDatabase.admitted
<nimblebrain_server_sdk.db.SecuredDatabase.admitted>`).
"""

from pgbulkhead.admission import (
    AdmittedSlot,
    Overloaded,
    PoolExhausted,
    WorkspaceBusy,
    WorkspaceLimiter,
    admitted_session,
)

__all__ = [
    "AdmittedSlot",
    "Overloaded",
    "PoolExhausted",
    "WorkspaceBusy",
    "WorkspaceLimiter",
    "admitted_session",
]
