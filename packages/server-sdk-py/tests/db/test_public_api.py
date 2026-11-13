"""The names and call shapes consumers use, pinned.

Every server that depends on this package imports from the names below. Each is pinned by its parameters (name, kind and
default, which is what a call site depends on), and each constant and agent-facing message by
its value, so a refactor underneath cannot change a consumer's behaviour without failing here.
"""

from __future__ import annotations

import dataclasses
import inspect
from typing import Any

import pytest

import nimblebrain_server_sdk.db as db
from nimblebrain_server_sdk.db.testing import use_limiter

E = inspect.Parameter.empty
POS = inspect.Parameter.POSITIONAL_OR_KEYWORD
KW = inspect.Parameter.KEYWORD_ONLY
VAR_KW = inspect.Parameter.VAR_KEYWORD

#: The names consumers import from the package root.
CONSUMED = {
    "AdmittedSlot",
    "AuthError",
    "Overloaded",
    "PoolSettings",
    "SecuredDatabase",
    "SecurityContext",
    "TENANT_HEADER",
    "WORKSPACE_HEADER",
    "WorkspaceLimiter",
    "org_session",
    "rls_policy_sql",
    "rls_policy_sql_org_scoped",
    "rls_policy_sql_tenant_scoped",
    "secured_session",
    "security_context_from_edge_headers",
    "system_session",
}


def params(obj: Any) -> list[tuple[str, Any, Any]]:
    return [(p.name, p.kind, p.default) for p in inspect.signature(obj).parameters.values()]


def test_consumed_names_are_exported() -> None:
    assert set(db.__all__) >= CONSUMED
    for name in db.__all__:
        assert hasattr(db, name), name


def test_all_is_unchanged() -> None:
    assert set(db.__all__) == CONSUMED | {
        "CLEANUP_TIMEOUT_SECONDS",
        "CONNECTIONS_PER_CALL",
        "PoolConfigError",
        "PoolExhausted",
        "WorkspaceBusy",
        "create_pooled_engine",
    }


def test_constants() -> None:
    assert db.TENANT_HEADER == "x-tenant-id"
    assert db.WORKSPACE_HEADER == "x-workspace-id"
    assert db.CLEANUP_TIMEOUT_SECONDS == 10.0
    assert db.CONNECTIONS_PER_CALL == 2


@pytest.mark.parametrize(
    ("obj", "expected"),
    [
        (db.rls_policy_sql, [("table", POS, E)]),
        (db.rls_policy_sql_tenant_scoped, [("table", POS, E)]),
        (db.rls_policy_sql_org_scoped, [("table", POS, E)]),
        (db.secured_session, [("engine", POS, E), ("ctx", POS, E)]),
        (db.system_session, [("engine", POS, E)]),
        (db.org_session, [("engine", POS, E), ("org_id", POS, E)]),
        (db.security_context_from_edge_headers, [("headers", POS, E), ("user_header", KW, None)]),
        (
            db.create_pooled_engine,
            [("url", POS, E), ("settings", POS, E), ("options", VAR_KW, E)],
        ),
        (db.SecurityContext.from_claims, [("claims", POS, E)]),
        (db.SecurityContext.identity_columns, [("self", POS, E)]),
        (db.SecurityContext.require_scope, [("self", POS, E), ("scope", POS, E)]),
        (
            db.PoolSettings.from_env,
            [("prefix", POS, E), ("defaults", KW, None), ("environ", KW, None)],
        ),
        (db.PoolSettings.engine_options, [("self", POS, E)]),
        (
            db.SecuredDatabase,
            [("url_env", KW, E), ("prefix", KW, E), ("defaults", KW, None), ("url", KW, None)],
        ),
        (db.SecuredDatabase.check, [("self", POS, E)]),
        (db.SecuredDatabase.get_engine, [("self", POS, E)]),
        (db.SecuredDatabase.dispose, [("self", POS, E)]),
        (db.SecuredDatabase.session, [("self", POS, E), ("ctx", POS, E)]),
        (db.SecuredDatabase.unadmitted_session, [("self", POS, E), ("ctx", POS, E)]),
        (db.SecuredDatabase.admitted, [("self", POS, E), ("ctx", POS, E)]),
        (db.SecuredDatabase.system_session, [("self", POS, E)]),
        (db.WorkspaceLimiter, [("limit", KW, E), ("wait_seconds", KW, E)]),
        (db.WorkspaceLimiter.from_settings, [("settings", POS, E)]),
        (db.WorkspaceLimiter.tracked, [("self", POS, E)]),
        (db.WorkspaceLimiter.admit, [("self", POS, E), ("ctx", POS, E)]),
        (db.AdmittedSlot, [("ctx", POS, E), ("open_session", POS, E)]),
        (db.AdmittedSlot.session, [("self", POS, E)]),
        (use_limiter, [("db", POS, E), ("limiter", POS, E)]),
    ],
    ids=lambda value: getattr(value, "__qualname__", None) or "",
)
def test_call_shape(obj: Any, expected: list[tuple[str, Any, Any]]) -> None:
    assert params(obj) == expected


def test_dataclass_fields() -> None:
    def fields(cls: Any) -> list[tuple[str, Any]]:
        return [(f.name, f.default) for f in dataclasses.fields(cls)]

    assert fields(db.SecurityContext) == [
        ("tenant_id", dataclasses.MISSING),
        ("workspace_id", dataclasses.MISSING),
        ("allowed_workspaces", frozenset()),
        ("scopes", frozenset()),
        ("user_id", None),
        ("correlation_id", None),
    ]
    assert db.SecurityContext.__dataclass_params__.frozen
    assert fields(db.PoolSettings) == [
        ("pool_size", 5),
        ("max_overflow", 5),
        ("pool_timeout_seconds", 10.0),
        ("workspace_concurrency", 2),
        ("workspace_wait_seconds", 15.0),
    ]


def test_properties() -> None:
    assert isinstance(inspect.getattr_static(db.PoolSettings, "total"), property)
    assert isinstance(inspect.getattr_static(db.SecuredDatabase, "settings"), property)
    assert isinstance(inspect.getattr_static(db.SecuredDatabase, "limiter"), property)


def test_error_hierarchy() -> None:
    assert issubclass(db.WorkspaceBusy, db.Overloaded)
    assert issubclass(db.PoolExhausted, db.Overloaded)
    assert issubclass(db.Overloaded, Exception)
    assert issubclass(db.PoolConfigError, ValueError)
    assert issubclass(db.AuthError, Exception)


def test_overload_text() -> None:
    """The host-safe text a server returns to the agent as ``rate_limited``."""
    assert db.Overloaded.message == "The server is at capacity right now. Nothing was run."
    assert db.Overloaded.next_step == "Wait a few seconds, then retry the call."
    assert db.WorkspaceBusy.message == (
        "This workspace already has as many requests running as the server allows at once, "
        "and this one waited too long for its turn. Nothing was run."
    )
    assert db.WorkspaceBusy.next_step == (
        "Wait a few seconds, then retry the call; send fewer calls at once."
    )
    assert db.PoolExhausted.message == (
        "The server has no free database connection right now. Nothing was run."
    )
    assert db.PoolExhausted.next_step == "Wait a few seconds, then retry the call."
    assert str(db.WorkspaceBusy()) == db.WorkspaceBusy.message


def test_use_limiter_swaps_the_database_limiter() -> None:
    database = db.SecuredDatabase(url_env="UNUSED_URL", prefix="UNUSED", url=lambda: "x")
    small = db.WorkspaceLimiter(limit=1, wait_seconds=0.1)
    before = database.limiter
    with use_limiter(database, small):
        assert database.limiter is small
    assert database.limiter is before
