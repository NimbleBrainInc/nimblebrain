"""Bundle-side wrapper for the `ai.nimblebrain/host-resources` extension.

The platform's TS implementation lives in
`src/host-resources/` in the NimbleBrain platform repo. This module
mirrors the wire shape exactly: same method names, same parameter
shapes, same result types (reused from `mcp.types`).
"""

from __future__ import annotations

from typing import Any, Literal, cast

from fastmcp import Context
from mcp.types import (
    ClientCapabilities,
    ListResourcesResult,
    ReadResourceResult,
    ServerRequest,
)
from pydantic import BaseModel, ConfigDict, Field

from nimblebrain_bundle_sdk.errors import HostCapabilityMissing
from nimblebrain_bundle_sdk.methods import (
    HOST_RESOURCES_CAPABILITY_KEY,
    HOST_RESOURCES_LIST_METHOD,
    HOST_RESOURCES_READ_METHOD,
)

# ---------------------------------------------------------------------------
# Request types
# ---------------------------------------------------------------------------
#
# `ServerSession.send_request` is typed against `ServerRequest`, a closed
# Pydantic `RootModel` union of the spec's known server→client request
# types. Custom methods like `ai.nimblebrain/resources/*` aren't in that
# union, so static typing won't accept us passing them directly.
#
# At runtime, `send_request` only calls `request.model_dump()` on the
# input and dumps the result onto the JSON-RPC stream (verified against
# `mcp` 1.27.x — see `mcp.shared.session.BaseSession.send_request`).
# Any Pydantic model with the right wire shape works. We define our
# request types as plain `BaseModel` subclasses and `cast` them to
# `ServerRequest` at the call site.
#
# # Runtime contract dependency
#
# The `cast` is a static-type accommodation today, but it *relies on*
# the dump-only behaviour of the mcp SDK's `send_request`. If the SDK
# ever switches to validating inputs against the `ServerRequest`
# RootModel (or constructing typed envelopes internally), the cast
# would break at runtime, not at import. The `pyproject.toml` deps pin
# `mcp<2.0` to bound this risk to minor-version drift, and the test
# matrix exercises the integration shape against current `mcp` on every
# CI run. Bump the pin and re-verify on the next minor release.


class _HostResourcesReadParams(BaseModel):
    uri: str


class _HostResourcesReadRequest(BaseModel):
    method: Literal["ai.nimblebrain/resources/read"] = HOST_RESOURCES_READ_METHOD  # type: ignore[assignment]
    params: _HostResourcesReadParams


class _HostResourcesListFilter(BaseModel):
    scheme: str | None = None
    mime_type: str | None = None
    tags: list[str] | None = None

    def to_wire(self) -> dict[str, Any]:
        """Hand-serialize to the camelCase wire shape.

        Pydantic aliasing (`Field(alias="mimeType")` + `populate_by_name`)
        is the more idiomatic way to do this, but it would only matter
        if callers were constructing this model directly. They aren't —
        `_HostResourcesListFilter` is internal and `HostResources.list()`
        builds it from kwargs, so the explicit dict-build is simpler
        than wiring + documenting an alias roundtrip.
        """
        out: dict[str, Any] = {}
        if self.scheme is not None:
            out["scheme"] = self.scheme
        if self.mime_type is not None:
            out["mimeType"] = self.mime_type
        if self.tags is not None:
            out["tags"] = self.tags
        return out


class _HostResourcesListMeta(BaseModel):
    filter: dict[str, Any] | None = None


class _HostResourcesListParams(BaseModel):
    # Wire convention: the filter rides in `_meta.filter` because the spec
    # `ListResourcesRequest` doesn't have a top-level `filter` field. The
    # platform's handler unwraps from there. Pydantic forbids attribute
    # names with a leading underscore (treated as private), so we name
    # the field `meta` in Python and alias it to `_meta` on the wire.
    # `populate_by_name=True` keeps both forms accepted at construction.
    meta: _HostResourcesListMeta | None = Field(default=None, alias="_meta")

    model_config = ConfigDict(populate_by_name=True)


class _HostResourcesListRequest(BaseModel):
    method: Literal["ai.nimblebrain/resources/list"] = HOST_RESOURCES_LIST_METHOD  # type: ignore[assignment]
    params: _HostResourcesListParams


# ---------------------------------------------------------------------------
# HostResources — the bundle-facing API
# ---------------------------------------------------------------------------


class HostResources:
    """Bundle-side handle for the host-resources extension.

    Construct via the `host(ctx)` factory rather than directly — the
    factory keeps the call site uniform across the SDK.
    """

    def __init__(self, ctx: Context):
        self._ctx = ctx

    # -- Capability probes --------------------------------------------------

    @property
    def available(self) -> bool:
        """True when the host advertised host-resources with **read** enabled.

        This is the common-case probe for `read()`. For `list()`, use
        `list_available` instead — a host could advertise `list.enabled`
        without `read.enabled` (or vice versa), and gating both methods
        on a single flag would silently mis-route.

        Reads from `ClientCapabilities.extensions["ai.nimblebrain/host-resources"]`,
        falling back to the legacy `experimental` slot for hosts that
        haven't migrated to the spec-blessed `extensions` field yet.
        Returns False on any malformed shape so a buggy host can't
        crash a bundle's availability probe.
        """
        return self._method_enabled("read")

    @property
    def list_available(self) -> bool:
        """True when the host advertised host-resources with **list** enabled.

        v1 hosts always ship `read` and `list` enabled together, so this
        will move in lockstep with `available` in practice. The split
        exists because the capability shape allows independent flags and
        the SDK shouldn't bake the lockstep assumption in — a future host
        that disables one method (e.g. read-only inventory listing) gets
        correct behaviour for free.
        """
        return self._method_enabled("list")

    def _method_enabled(self, method: str) -> bool:
        """Per-method capability gate. Shared by `available` /
        `list_available` and the per-call guards in `read` / `list`."""
        cap = self._capability_block()
        if cap is None:
            return False
        block = cap.get(method)
        if not isinstance(block, dict):
            return False
        return bool(block.get("enabled"))

    def supports_scheme(self, scheme: str) -> bool:
        """True when the host advertised the given URI scheme.

        The host-resources capability includes a `schemes` allowlist
        (`["files"]` in v1). Bundles check this before issuing a read
        against an `entities://` URI etc., since the platform will
        return `-32602 Invalid params` for any scheme outside the
        allowlist.
        """
        cap = self._capability_block()
        if cap is None:
            return False
        schemes = cap.get("schemes")
        return isinstance(schemes, list) and scheme in schemes

    # -- Methods ------------------------------------------------------------

    async def read(self, uri: str) -> ReadResourceResult:
        """Read a single workspace resource by URI.

        Raises `HostCapabilityMissing` if the host hasn't advertised the
        extension with `read.enabled` — check `available` first, or
        catch and fall back to a structured tool error (the Level-C
        pattern).

        Raises `McpError` for wire-level errors:
        - `-32002 Resource not found` (also: cross-workspace lookup)
        - `-32004 Rate limited` (with `retryAfterMs` in `error.data`)
        - `-32005 Response too large` (with `size`, `maxSize`)
        - `-32602 Invalid params` (unsupported scheme)
        """
        if not self._method_enabled("read"):
            raise HostCapabilityMissing(HOST_RESOURCES_CAPABILITY_KEY)

        request = _HostResourcesReadRequest(params=_HostResourcesReadParams(uri=uri))
        return await self._ctx.session.send_request(
            cast(ServerRequest, request),
            ReadResourceResult,
        )

    async def list(
        self,
        *,
        scheme: str | None = None,
        mime_type: str | None = None,
        tags: list[str] | None = None,
    ) -> ListResourcesResult:
        """List workspace resources, optionally filtered.

        Filters are AND-combined (resources must match every constraint).
        Pagination via `cursor` is not supported in v1 — the platform
        returns the full set in one response and rejects non-empty
        cursors with `-32602`.

        Raises `HostCapabilityMissing` if the host hasn't advertised
        the extension with `list.enabled` — check `list_available`
        before calling, or catch and fall back. Wire errors propagate as
        `McpError` (see `read`).
        """
        if not self._method_enabled("list"):
            raise HostCapabilityMissing(HOST_RESOURCES_CAPABILITY_KEY)

        filter_obj = _HostResourcesListFilter(scheme=scheme, mime_type=mime_type, tags=tags)
        filter_wire = filter_obj.to_wire()
        # Drop `meta` entirely when there's no filter so the wire-side
        # `params` is empty (matches "list everything in this workspace"
        # without ambiguity). `exclude_none=True` on `model_dump` handles
        # the drop.
        meta = _HostResourcesListMeta(filter=filter_wire) if filter_wire else None
        params = _HostResourcesListParams(meta=meta)
        request = _HostResourcesListRequest(params=params)
        return await self._ctx.session.send_request(
            cast(ServerRequest, request),
            ListResourcesResult,
        )

    # -- Internals ----------------------------------------------------------

    def _capability_block(self) -> dict[str, Any] | None:
        """Return the raw capability dict, or None if not advertised.

        Probes `ClientCapabilities.extensions` first (spec-blessed
        location), then `experimental` (legacy fallback). Either
        location is read via `model_extra` because the `mcp` Python
        SDK (as of 1.27.0) declares `experimental` as a typed field
        but not `extensions` — `extra="allow"` on the model keeps
        unknown keys accessible.
        """
        client_params = getattr(self._ctx.session, "client_params", None)
        if client_params is None:
            return None
        caps = getattr(client_params, "capabilities", None)
        if not isinstance(caps, ClientCapabilities):
            return None

        # Prefer `extensions`. Pydantic's `model_extra` holds fields not
        # declared on the model when `extra="allow"`.
        extensions = (caps.model_extra or {}).get("extensions")
        if isinstance(extensions, dict):
            cap = extensions.get(HOST_RESOURCES_CAPABILITY_KEY)
            if isinstance(cap, dict):
                return cap

        # Fall back to the legacy `experimental` slot — older platforms
        # (or older spec versions) put vendor extensions there.
        experimental = caps.experimental
        if isinstance(experimental, dict):
            cap = experimental.get(HOST_RESOURCES_CAPABILITY_KEY)
            if isinstance(cap, dict):
                return cap

        return None


def host(ctx: Context) -> HostResources:
    """Bundle-facing entry point. Wraps a FastMCP `Context` into a typed
    handle for the host-resources extension.

    Idiomatic usage:

        h = host(ctx)
        if h.available:
            result = await h.read("files://fl_abc123")
    """
    return HostResources(ctx)
