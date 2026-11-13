"""NimbleBrain's tenancy models: the ``pgbulkhead`` configurations its servers run.

Every policy and session this package renders or binds goes through one of these three, so
they are pinned byte for byte by the golden SQL tests. Changing a field here changes the SQL a
replayed migration builds: a schema change, which needs its own migration.

  * :data:`NIMBLEBRAIN`: tenant + workspace, per-command policies, the ``app.role = 'system'``
    workspace bypass, scopes bound to ``app.scopes``. ``allowed_workspaces`` is bound exactly
    as the context carries it (``from_claims`` and the edge both include the active workspace).
  * :data:`TENANT_SCOPED`: a tenant-global ledger; single key, no bypass.
  * :data:`ORG_SCOPED`: an identity provider's organization as the only key (``org_id``), for
    a service with no platform tenant; single key, no bypass.

The single-key presets drop only their own policy name when re-rendered, as they always have.
"""

from __future__ import annotations

from pgbulkhead import GucBypass, TenancyModel

__all__ = ["NIMBLEBRAIN", "ORG_SCOPED", "TENANT_SCOPED"]

NIMBLEBRAIN = TenancyModel(
    namespace="app",
    scopes_setting="app.scopes",
    bypass=GucBypass(),
    active_is_readable=False,
)
TENANT_SCOPED = TenancyModel(workspace_column=None, namespace="app", drop_other_shape=False)
ORG_SCOPED = TenancyModel(
    tenant_column="org_id", workspace_column=None, namespace="app", drop_other_shape=False
)
