"""Tests for the bundle-side HostResources wrapper.

The SDK is a thin wrapper. The contract these tests pin:

1. Capability detection reads `ClientCapabilities.extensions` first,
   falls back to `experimental` for legacy hosts, defaults to False on
   absent/malformed shapes.
2. `read` and `list` dispatch the correct namespaced method with the
   correct wire-shape params (URI / `_meta.filter` containing
   `mimeType`, `tags`).
3. `HostCapabilityMissing` raises locally — no wire call — when the
   capability isn't advertised.
4. `list` rejects invalid filter shapes the platform handler would
   reject (we leave most validation to the platform; the SDK just
   serializes).
"""

from __future__ import annotations

import pytest
from mcp.types import ReadResourceResult

from nimblebrain_bundle_sdk import (
    HOST_RESOURCES_CAPABILITY_KEY,
    HOST_RESOURCES_LIST_METHOD,
    HOST_RESOURCES_READ_METHOD,
    HostCapabilityMissing,
    host,
)
from tests.conftest import make_ctx

# ---------------------------------------------------------------------------
# Capability detection
# ---------------------------------------------------------------------------


def test_available_true_when_host_advertises_extensions(host_resources_v1_extensions):
    ctx = make_ctx(extensions=host_resources_v1_extensions)
    assert host(ctx).available is True


def test_available_true_via_experimental_fallback(host_resources_v1_extensions):
    # Older hosts may put vendor extensions in `experimental` instead of
    # `extensions`. The SDK should still detect them.
    ctx = make_ctx(experimental=host_resources_v1_extensions)
    assert host(ctx).available is True


def test_available_false_when_no_caps():
    ctx = make_ctx()
    assert host(ctx).available is False


def test_available_false_when_read_disabled():
    # Host advertised the capability key but with read.enabled=false.
    # SDK should refuse to call methods.
    ctx = make_ctx(
        extensions={HOST_RESOURCES_CAPABILITY_KEY: {"read": {"enabled": False}}},
    )
    assert host(ctx).available is False


def test_available_false_on_malformed_shape():
    # A buggy host that sends a non-dict for the capability shouldn't
    # crash the bundle's availability probe.
    ctx = make_ctx(extensions={HOST_RESOURCES_CAPABILITY_KEY: "not-a-dict"})  # type: ignore[dict-item]
    assert host(ctx).available is False


def test_supports_scheme(host_resources_v1_extensions):
    ctx = make_ctx(extensions=host_resources_v1_extensions)
    h = host(ctx)
    assert h.supports_scheme("files") is True
    assert h.supports_scheme("entities") is False


def test_supports_scheme_false_when_unavailable():
    ctx = make_ctx()
    assert host(ctx).supports_scheme("files") is False


def test_supports_scheme_false_on_malformed_schemes():
    """A host that advertised `schemes` as a non-list (a string, dict,
    whatever) shouldn't crash the bundle's scheme probe. The defensive
    `isinstance(schemes, list)` guard in host.py:146 covers this — pin
    it so a future "simplification" of the guard fails CI."""
    ctx = make_ctx(
        extensions={
            HOST_RESOURCES_CAPABILITY_KEY: {
                "read": {"enabled": True},
                # Wrong shape — should be a list. Buggy host.
                "schemes": "files",  # type: ignore[dict-item]
            }
        }
    )
    assert host(ctx).supports_scheme("files") is False


# ---------------------------------------------------------------------------
# read()
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_dispatches_namespaced_method(host_resources_v1_extensions, read_result_ok):
    ctx = make_ctx(extensions=host_resources_v1_extensions, next_response=read_result_ok)
    result = await host(ctx).read("files://fl_abc")

    assert isinstance(result, ReadResourceResult)
    assert result.contents[0].text == "company,email\nfoo,foo@x"

    # Exactly one wire call, with the right method + params shape.
    assert len(ctx.session.calls) == 1
    call = ctx.session.calls[0]
    assert call.method == HOST_RESOURCES_READ_METHOD
    assert call.params == {"uri": "files://fl_abc"}


@pytest.mark.asyncio
async def test_read_raises_host_capability_missing_when_unavailable():
    ctx = make_ctx()
    with pytest.raises(HostCapabilityMissing) as exc_info:
        await host(ctx).read("files://fl_abc")
    assert HOST_RESOURCES_CAPABILITY_KEY in str(exc_info.value)
    # No wire call should have been made — the guard fires locally.
    assert ctx.session.calls == []


# ---------------------------------------------------------------------------
# list()
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_dispatches_namespaced_method_with_no_filter(
    host_resources_v1_extensions, list_result_ok
):
    ctx = make_ctx(extensions=host_resources_v1_extensions, next_response=list_result_ok)
    await host(ctx).list()

    assert len(ctx.session.calls) == 1
    call = ctx.session.calls[0]
    assert call.method == HOST_RESOURCES_LIST_METHOD
    # No filter → params is empty (`_meta` gets dropped by exclude_none).
    assert call.params == {}


@pytest.mark.asyncio
async def test_list_wraps_mime_type_filter_in_meta(host_resources_v1_extensions, list_result_ok):
    ctx = make_ctx(extensions=host_resources_v1_extensions, next_response=list_result_ok)
    await host(ctx).list(mime_type="text/csv")

    call = ctx.session.calls[0]
    # Wire shape: `_meta.filter.mimeType` (camelCase, per MCP convention).
    # The platform handler's unwrap reads from exactly this location.
    assert call.params == {"_meta": {"filter": {"mimeType": "text/csv"}}}


@pytest.mark.asyncio
async def test_list_wraps_tags_filter_in_meta(host_resources_v1_extensions, list_result_ok):
    ctx = make_ctx(extensions=host_resources_v1_extensions, next_response=list_result_ok)
    await host(ctx).list(tags=["draft"])

    call = ctx.session.calls[0]
    assert call.params == {"_meta": {"filter": {"tags": ["draft"]}}}


@pytest.mark.asyncio
async def test_list_combines_filters(host_resources_v1_extensions, list_result_ok):
    ctx = make_ctx(extensions=host_resources_v1_extensions, next_response=list_result_ok)
    await host(ctx).list(scheme="files", mime_type="text/csv", tags=["draft"])

    call = ctx.session.calls[0]
    assert call.params == {
        "_meta": {"filter": {"scheme": "files", "mimeType": "text/csv", "tags": ["draft"]}}
    }


@pytest.mark.asyncio
async def test_list_raises_host_capability_missing_when_unavailable():
    ctx = make_ctx()
    with pytest.raises(HostCapabilityMissing):
        await host(ctx).list()
    assert ctx.session.calls == []
