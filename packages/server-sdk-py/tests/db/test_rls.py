"""The RLS template must encode the security-critical invariants."""

from __future__ import annotations

from nimblebrain_server_sdk.db import (
    rls_policy_sql,
    rls_policy_sql_org_scoped,
    rls_policy_sql_tenant_scoped,
)


def test_force_rls_present() -> None:
    # FORCE makes even the table owner subject to the policy.
    assert "FORCE ROW LEVEL SECURITY" in rls_policy_sql("crm_contacts")


def _policy(sql: str, name: str) -> str:
    """The ``CREATE POLICY <name>`` block, sliced to the next statement."""
    start = sql.index(f"CREATE POLICY {name} ")
    end = sql.find("CREATE POLICY ", start + 1)
    return sql[start:] if end == -1 else sql[start:end]


def test_emits_per_command_policies_not_for_all() -> None:
    # A single FOR ALL policy can't gate DELETE (it takes no WITH CHECK) or
    # UPDATE row-selection on the active workspace; four per-command policies do.
    sql = rls_policy_sql("crm_contacts")
    for cmd in ("SELECT", "INSERT", "UPDATE", "DELETE"):
        assert f"FOR {cmd}" in sql
    # the DELETE gap the single policy left open: a USING row filter now exists.
    assert "USING" in _policy(sql, "crm_contacts_delete")


def test_tenant_is_required_on_every_command() -> None:
    # The tenant wall is a top-level AND on all five command clauses: SELECT
    # USING, INSERT WITH CHECK, UPDATE USING + WITH CHECK, DELETE USING.
    sql = rls_policy_sql("crm_contacts")
    tenant = "tenant_id = current_setting('app.tenant_id', true)"
    assert sql.count(tenant) == 5
    assert f"{tenant} AND" in sql  # conjoined, never OR'd with the system escape


def test_read_spans_allowed_workspaces_but_writes_bind_active() -> None:
    sql = rls_policy_sql("crm_contacts")
    # READ spans the allowed set (active ∪ read grants)...
    assert "app.allowed_workspaces" in _policy(sql, "crm_contacts_select")
    # ...every WRITE binds the ACTIVE workspace and never the grant set, so a read
    # grant implies no insert, update (incl. relabel), or delete in that workspace.
    for cmd in ("insert", "update", "delete"):
        stmt = _policy(sql, f"crm_contacts_{cmd}")
        assert "app.workspace_id" in stmt
        assert "app.allowed_workspaces" not in stmt


def test_system_role_bypasses_workspace_not_tenant() -> None:
    sql = rls_policy_sql("crm_contacts")
    # the system escape exists (workspace bypass for reconcilers/admin)...
    assert "current_setting('app.role', true) = 'system'" in sql
    # ...but the tenant wall is never gated by it.
    assert "'system' OR tenant_id" not in sql


def test_table_name_is_substituted() -> None:
    sql = rls_policy_sql("crm_deals")
    assert "CREATE POLICY crm_deals_select ON crm_deals" in sql
    assert "CREATE POLICY crm_deals_delete ON crm_deals" in sql


# --------------------------------------------------------------------------- #
# rls_policy_sql_tenant_scoped — the tenant-global ledger policy.               #
# --------------------------------------------------------------------------- #


def test_tenant_scoped_enables_and_forces_rls() -> None:
    # ENABLE + FORCE so even the table owner is subject to the policy (RLS load-bearing).
    sql = rls_policy_sql_tenant_scoped("pebble")
    assert "ENABLE ROW LEVEL SECURITY" in sql
    assert "FORCE ROW LEVEL SECURITY" in sql


def test_tenant_scoped_gates_read_and_write_on_tenant_only() -> None:
    """Both READ (USING) and WRITE (WITH CHECK) scope on tenant_id — no workspace clause."""
    sql = rls_policy_sql_tenant_scoped("pebble")
    using, check = sql.split("WITH CHECK", 1)
    assert "tenant_id = current_setting('app.tenant_id', true)" in using  # read
    assert "tenant_id = current_setting('app.tenant_id', true)" in check  # write
    # The tenant check appears on BOTH arms and nowhere is it gated by anything else.
    assert sql.count("tenant_id = current_setting('app.tenant_id', true)") == 2


def test_tenant_scoped_has_no_workspace_clause() -> None:
    """A tenant-global ledger does NOT scope on workspace — the fact binds across all of the
    tenant's workspaces (an opt-out is company-wide), so no workspace GUC appears."""
    sql = rls_policy_sql_tenant_scoped("pebble")
    assert "app.workspace_id" not in sql
    assert "app.allowed_workspaces" not in sql


def test_tenant_scoped_omits_the_system_role_escape() -> None:
    """It INTENTIONALLY omits the ``app.role='system'`` bypass that the workspace policy carries
    (every ledger writer must be tenant-authenticated; there is no system-push reconciler)."""
    sql = rls_policy_sql_tenant_scoped("pebble")
    assert "system" not in sql
    assert "app.role" not in sql


def test_tenant_scoped_table_name_is_substituted() -> None:
    sql = rls_policy_sql_tenant_scoped("audit_log")
    assert "CREATE POLICY audit_log_isolation ON audit_log" in sql


# --------------------------------------------------------------------------- #
# org-scoped policy (the single-key form for an identity-provider organization) #
# --------------------------------------------------------------------------- #


def test_org_scoped_forces_rls() -> None:
    # FORCE, so even the table owner is subject to the policy.
    assert "FORCE ROW LEVEL SECURITY" in rls_policy_sql_org_scoped("bramble_fern")


def test_org_scoped_keys_on_org_id_for_read_and_write() -> None:
    sql = rls_policy_sql_org_scoped("bramble_fern")
    assert "USING (org_id = current_setting('app.org_id', true))" in sql
    assert "WITH CHECK (org_id = current_setting('app.org_id', true))" in sql


def test_org_scoped_uses_missing_ok_current_setting() -> None:
    # `true` = "missing_ok": NULL when unset, so an unscoped session matches no
    # row. Default-deny is the property; a raising current_setting would make an
    # unscoped read an error to be caught rather than an empty result.
    assert "current_setting('app.org_id', true)" in rls_policy_sql_org_scoped("quartz")


def test_org_scoped_has_no_system_role_bypass() -> None:
    # Deliberate: a cross-org sweep must bind a concrete org per organization it
    # touches. A role bypass here would be a hole in the plane the whole
    # org-scoped design rests on.
    assert "app.role" not in rls_policy_sql_org_scoped("bramble_chalk")


def test_key_shapes_cannot_be_confused() -> None:
    """The three policies bind disjoint GUCs, so mixing them fails CLOSED.

    A session that binds app.tenant_id/app.workspace_id matches nothing on an
    org-scoped table, and one that binds app.org_id matches nothing on a
    tenant-scoped one — because each policy's predicate names only its own GUC
    and `current_setting(.., true)` is NULL for the others. This is what makes a
    third key shape safe to add: the failure mode of getting it wrong is an
    empty result, never a cross-boundary read.
    """
    org = rls_policy_sql_org_scoped("bramble_fern")
    tenant = rls_policy_sql_tenant_scoped("pebble")
    workspace = rls_policy_sql("crm_contacts")

    assert "app.tenant_id" not in org and "app.workspace_id" not in org
    assert "app.org_id" not in tenant
    assert "app.org_id" not in workspace
