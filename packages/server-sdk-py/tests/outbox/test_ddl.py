"""The DDL an adopter pastes into a migration.

It is rendered from the same :class:`~sqlalchemy.Table` the queries are built
against, so these assert the things that would still be wrong if the two agreed:
that the security policy is applied to *both* tables, and that the indexes the
poll and the cap depend on exist.
"""

from __future__ import annotations

import sqlalchemy as sa

from nimblebrain_server_sdk.outbox import outbox_ddl, outbox_table


def statements(name: str = "notification_outbox") -> list[str]:
    return outbox_ddl(outbox_table(sa.MetaData(), name))


def ddl(name: str = "notification_outbox") -> str:
    return "\n".join(statements(name))


def test_is_one_statement_per_item_with_no_semicolons() -> None:
    """asyncpg refuses multiple commands per execute, so the split is the library's
    job rather than something every adopter rediscovers and re-implements."""
    for statement in statements():
        assert ";" not in statement
        assert statement.strip() == statement


def test_creates_the_outbox_and_its_state_table() -> None:
    sql = ddl()
    assert "CREATE TABLE notification_outbox (" in sql
    assert "CREATE TABLE notification_outbox_state (" in sql


def test_both_tables_get_the_standard_rls_policy() -> None:
    """The state table carries the epoch and the loss watermark — per workspace,
    and therefore behind the same wall as the events themselves."""
    sql = ddl()
    for table in ("notification_outbox", "notification_outbox_state"):
        assert f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY" in sql
        for command in ("select", "insert", "update", "delete"):
            assert f"CREATE POLICY {table}_{command} ON {table}" in sql


def test_the_transaction_id_is_written_by_the_database() -> None:
    """Never by the caller: it is the ordering the no-skip property rests on."""
    assert "txid BIGINT DEFAULT (pg_current_xact_id()::text::bigint) NOT NULL" in ddl()


def test_the_dedupe_key_is_workspace_scoped() -> None:
    assert "UNIQUE (workspace_id, event_id)" in ddl()


def test_the_poll_and_retention_indexes_exist() -> None:
    sql = ddl()
    # The poll reads one workspace's rows from a transaction id up, in read
    # order; the cap trims in that same order.
    assert (
        "CREATE INDEX notification_outbox_poll_idx ON notification_outbox "
        "(workspace_id, txid, seq)" in sql
    )
    # Retention deletes by how long a row has been delivered.
    assert (
        "CREATE INDEX notification_outbox_retention_idx ON notification_outbox "
        "(workspace_id, first_read_at)" in sql
    )


def test_a_renamed_table_renames_everything_that_hangs_off_it() -> None:
    sql = ddl("acme_events")
    assert "CREATE TABLE acme_events (" in sql
    assert "CREATE TABLE acme_events_state (" in sql
    assert "CREATE POLICY acme_events_select ON acme_events" in sql
    assert "CREATE INDEX acme_events_poll_idx ON acme_events" in sql
    assert "notification_outbox" not in sql
