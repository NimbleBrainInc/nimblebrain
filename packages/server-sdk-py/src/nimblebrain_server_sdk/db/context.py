"""The verified request identity.

Built ONLY from a verified token's claims. Nothing here may come from a request
body — the body can *request* a workspace, but the token must *permit* it. The
NimbleBrain host is the authority for workspace identity and membership and asserts it into
the token; servers only verify and enforce on it.
"""

from __future__ import annotations

from dataclasses import dataclass

import pgbulkhead
from pgbulkhead import context_from_claims


@dataclass(frozen=True, slots=True)
class SecurityContext(pgbulkhead.SecurityContext):
    """Identity + grants for one request.

    - ``tenant_id`` — the **hard** isolation boundary. Never crossed.
    - ``workspace_id`` — the **active** workspace (the soft boundary).
    - ``allowed_workspaces`` — workspaces this principal may **read** across,
      from explicit grants embedded in the token. Always includes
      the active workspace. A read grant does NOT imply write (writes go to the
      active workspace only — enforced by the RLS ``WITH CHECK``).
    - ``scopes`` — capability scopes (e.g. ``crm:write``).
    """

    # Required here, unlike pgbulkhead's (where a single-key model has no workspace): every
    # NimbleBrain context names its active workspace.
    workspace_id: str

    @classmethod
    def from_claims(cls, claims: dict[str, object]) -> SecurityContext:
        """Build from VERIFIED token claims. Raises if tenant/workspace absent —
        fail closed rather than default to a permissive scope."""
        return context_from_claims(claims, cls=cls)

    def identity_columns(self) -> dict[str, str]:
        """The ``tenant_id`` / ``workspace_id`` columns a row inserted under this context
        carries: the active workspace, the only one the RLS ``WITH CHECK`` admits a write to."""
        return {"tenant_id": self.tenant_id, "workspace_id": self.workspace_id}
