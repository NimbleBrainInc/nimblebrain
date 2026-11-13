"""The standard RLS policy every shared-service table applies.

Apply in a migration for each table tagged ``(tenant_id, workspace_id)``. The
read/write asymmetry is the security crux:

  * **READ** (``SELECT`` ``USING``): tenant must match AND workspace must be in
    the principal's allowed set (active workspace ∪ read-granted workspaces).
  * **WRITE** (``INSERT`` / ``UPDATE`` / ``DELETE``): tenant must match AND
    workspace must be the **active** workspace only — enforced on both the row
    selected (``USING``, so UPDATE/DELETE cannot touch a granted workspace's
    rows) and the row written (``WITH CHECK``). A cross-workspace *read* grant
    never implies the right to write, relabel, or delete in another workspace.
  * **``system``** role bypasses *workspace* scoping (reconcilers/admin), but
    NEVER the tenant wall.

Operational contract (or this is silently void): the app DB role MUST be
non-superuser without ``BYPASSRLS``. ``FORCE ROW LEVEL SECURITY`` makes even the
table owner subject to the policy. ``current_setting(.., true)`` returns NULL when
unset, so an unscoped session sees nothing — default deny.
"""

from __future__ import annotations

from pgbulkhead import policy_sql

from .presets import NIMBLEBRAIN, ORG_SCOPED, TENANT_SCOPED


def rls_policy_sql(table: str) -> str:
    """Render the standard tenant+workspace RLS policy DDL for ``table``.

    Emitted as four **per-command** policies so the read/write asymmetry holds
    for every command, not just INSERT:

      * ``SELECT`` — tenant match AND workspace in the allowed set (active ∪ read
        grants).
      * ``INSERT`` / ``UPDATE`` / ``DELETE`` — tenant match AND the **active**
        workspace only.

    A single ``FOR ALL`` policy cannot express this. PostgreSQL applies
    ``WITH CHECK`` only to the *new* row of INSERT/UPDATE and **never** to
    DELETE, while ``USING`` decides which *existing* rows UPDATE/DELETE may
    touch. With one policy the read predicate (the allowed set) therefore
    governed DELETE and UPDATE row-selection, so a cross-workspace *read* grant
    could DELETE a granted workspace's rows or UPDATE-relabel them into the
    active workspace. Splitting per command binds writes to the active workspace
    on both the row selected (``USING``) and the row written (``WITH CHECK``).
    The ``system`` role still bypasses *workspace* scoping (reconcilers/admin)
    but never the tenant wall. The leading ``DROP``s (old single ``_isolation``
    name + the four per-command names) make the DDL idempotent and upgrade an
    existing table from the prior single-policy form.
    """
    return policy_sql(NIMBLEBRAIN, table)


def rls_policy_sql_tenant_scoped(table: str) -> str:
    """Render a TENANT-SCOPED RLS policy for a tenant-global ledger table.

    For tables that hold a tenant-level FACT, not workspace business data — a legal
    opt-out / suppression list, an audit log, billing. Such a fact binds across ALL of a
    tenant's workspaces (a recipient opts out from the company, not one workspace), so both
    READ (``USING``) and WRITE (``WITH CHECK``) scope on the tenant only; ``workspace_id``
    on the row is provenance (which workspace recorded it), never an access key.

    Tenant is still the hard wall, and ``current_setting(.., true)`` is NULL when unset, so
    an unscoped session sees nothing — default-deny, exactly like :func:`rls_policy_sql`.
    Use this ONLY for genuinely tenant-global tables; workspace business data MUST use the
    workspace-scoped :func:`rls_policy_sql`.

    NOTE: this policy INTENTIONALLY omits the ``app.role='system'`` escape that
    :func:`rls_policy_sql` carries, so every writer must be tenant-authenticated. A
    ``system_session`` reconciler or an async webhook (a write with no tenant on the request)
    would be SILENTLY DENIED here: it must bind a concrete ``app.tenant_id`` per row it writes
    (one scoped session per tenant), since there is no role bypass to lean on.
    """
    return policy_sql(TENANT_SCOPED, table)


def rls_policy_sql_org_scoped(table: str) -> str:
    """Render a single-key RLS policy for a table isolated by ``org_id``.

    For a service whose outermost isolation boundary is an **identity provider's
    organization**, not the platform's tenant: one that holds no platform token and
    therefore has no ``tenant_id``, and has no workspace dimension of its own (a
    messaging bridge that *forwards* a workspace to a runtime, say, never enforcing it
    as a wall). What it does have is a hard wall, and ``org_id`` is it: organization
    A's rows must never be visible to organization B.

    ``org_id`` IS NOT ``tenant_id``, and the two must not be read as peers:

      * ``tenant_id`` is the platform's own tenant, asserted by the NimbleBrain host into
        a verified platform token. A service holding one
        MUST use :func:`rls_policy_sql` (or :func:`rls_policy_sql_tenant_scoped`)
        and :func:`~nimblebrain_server_sdk.db.session.secured_session`.
      * ``org_id`` is an upstream identity provider's organization id. It is the
        isolation key *within* such a service's own database and nothing more. In
        particular it is NOT an authorization decision anywhere else: such a
        service routes on an admin-established binding, never on the ``org_id`` in
        a token it relays. Isolating rows by it and routing on it are different
        acts; this function is only the first.

    The caller MUST bind the org from something it has verified — a link row the
    request already resolved, or a validated token — and NEVER from a vendor
    payload or a request body. That is the same invariant
    :class:`~nimblebrain_server_sdk.db.context.SecurityContext` enforces for tenant
    claims, with a different verifier.

    Shape-wise this is the one-key form :func:`rls_policy_sql_tenant_scoped`
    already established, under a different column: both READ (``USING``) and
    WRITE (``WITH CHECK``) scope on the single key, and
    ``current_setting(.., true)`` is NULL when unset, so an **unscoped session
    sees nothing** — default deny. Mixing shapes therefore fails CLOSED: a
    session that binds ``app.tenant_id``/``app.workspace_id`` matches no row on
    an org-scoped table, and vice versa.

    Like the tenant-scoped policy, this INTENTIONALLY carries no
    ``app.role='system'`` escape. A reconciler or sweep that must cross
    organizations (re-encrypting every stored ciphertext under a rotated master,
    say) has no role bypass to lean on: it must bind a concrete ``app.org_id``
    per organization it touches, one scoped session at a time. That is deliberate
    — a cross-org read grant on these tables would be a hole in the plane the
    whole design depends on.
    """
    return policy_sql(ORG_SCOPED, table)
