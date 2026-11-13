"""``secured_session`` refuses a context it cannot bind faithfully, before connecting.

The read grants and scopes are bound comma-joined and the policy splits them on commas again, so
a value containing a comma would bind as several and widen the read set. An empty tenant or
workspace would bind a value that matches nothing and read as an empty result.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from nimblebrain_server_sdk.db import SecurityContext, secured_session

#: Never connected to: every case is refused before checkout.
ENGINE = create_async_engine("postgresql+asyncpg://unused@127.0.0.1:1/unused")


@pytest.mark.parametrize(
    "ctx",
    [
        SecurityContext(tenant_id="", workspace_id="ws-a"),
        SecurityContext(tenant_id="tenant-a", workspace_id=""),
        SecurityContext(tenant_id="tenant-a", workspace_id="ws-a,ws-b"),
        SecurityContext(
            tenant_id="tenant-a", workspace_id="ws-a", allowed_workspaces=frozenset({"ws-a,ws-b"})
        ),
        SecurityContext(
            tenant_id="tenant-a", workspace_id="ws-a", allowed_workspaces=frozenset({""})
        ),
        SecurityContext(
            tenant_id="tenant-a", workspace_id="ws-a", scopes=frozenset({"read,admin"})
        ),
    ],
    ids=[
        "empty-tenant",
        "empty-workspace",
        "comma-workspace",
        "comma-grant",
        "empty-grant",
        "comma-scope",
    ],
)
async def test_refused_before_binding(ctx: SecurityContext) -> None:
    with pytest.raises(ValueError):
        async with secured_session(ENGINE, ctx):
            pytest.fail("opened a session for a context it cannot bind faithfully")
