"""SecurityContext: identity comes from verified claims, fail-closed."""

from __future__ import annotations

import pytest

from nimblebrain_server_sdk.db import SecurityContext


def test_active_workspace_is_always_allowed() -> None:
    ctx = SecurityContext.from_claims({"tenant_id": "t1", "workspace_id": "w1"})
    assert ctx.workspace_id in ctx.allowed_workspaces


def test_read_grants_merge_with_active() -> None:
    ctx = SecurityContext.from_claims(
        {"tenant_id": "t1", "workspace_id": "w1", "allowed_workspaces": ["w2", "w3"]}
    )
    assert ctx.allowed_workspaces == frozenset({"w1", "w2", "w3"})


def test_missing_tenant_or_workspace_fails_closed() -> None:
    with pytest.raises(ValueError):
        SecurityContext.from_claims({"workspace_id": "w1"})
    with pytest.raises(ValueError):
        SecurityContext.from_claims({"tenant_id": "t1"})


def test_require_scope() -> None:
    ctx = SecurityContext.from_claims(
        {"tenant_id": "t1", "workspace_id": "w1", "scopes": ["crm:read"]}
    )
    ctx.require_scope("crm:read")
    with pytest.raises(PermissionError):
        ctx.require_scope("crm:write")
