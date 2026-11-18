"""The SDK for building MCP servers that run on NimbleBrain.

What a server shares with the host it runs in: the tool annotation hints, the change
announcement its views re-read on, the platform extensions (facets, lifecycle handlers, the
view a record opens in), skills served through the MCP Skills extension
(``io.modelcontextprotocol/skills``), the bounded row a listing returns, the opaque record id it
mints, reads of workspace files through ``ai.nimblebrain/host-resources``, and the MCP Server
Card a host reads before it connects.
"""

from importlib.metadata import version as _version

from nimblebrain_server_sdk.annotations import ADDS, CHANGES, READS
from nimblebrain_server_sdk.announce import announce_resource_list_changed
from nimblebrain_server_sdk.error_contract import ErrorContractMiddleware, add_error_contract
from nimblebrain_server_sdk.errors import HostCapabilityMissing
from nimblebrain_server_sdk.extensions.facets import (
    FACET_LEVELS,
    FACETS_EXTENSION_ID,
    FacetLevel,
    facet_count,
    facet_meta,
)
from nimblebrain_server_sdk.extensions.lifecycle import (
    LIFECYCLE_EVENTS,
    LIFECYCLE_EXTENSION_ID,
    LifecycleEvent,
    LifecycleExtension,
    add_lifecycle_extension,
    lifecycle_meta,
)
from nimblebrain_server_sdk.extensions.platform import PlatformExtension, add_platform_extension
from nimblebrain_server_sdk.extensions.views import RECORD_VIEW_META, record_view_meta
from nimblebrain_server_sdk.host import HostResources, host
from nimblebrain_server_sdk.ids import new_prefixed_id, new_ulid
from nimblebrain_server_sdk.methods import (
    HOST_RESOURCES_CAPABILITY_KEY,
    HOST_RESOURCES_LIST_METHOD,
    HOST_RESOURCES_READ_METHOD,
    INVALID_PARAMS,
    RATE_LIMITED,
    RESOURCE_NOT_FOUND,
    RESPONSE_TOO_LARGE,
)
from nimblebrain_server_sdk.rows import PREVIEW_CHARS, listing_row, preview_text
from nimblebrain_server_sdk.server_card import (
    HOST_META_KEY,
    SERVER_CARD_MEDIA_TYPE,
    SERVER_CARD_SCHEMA,
    Placement,
    add_server_card,
)
from nimblebrain_server_sdk.skills import (
    SKILLS_EXTENSION_ID,
    MCPServerSkillsExtension,
    SkillDefinition,
    SkillsExtension,
    add_skills,
)

__all__ = [
    "ADDS",
    "CHANGES",
    "FACETS_EXTENSION_ID",
    "FACET_LEVELS",
    "HOST_META_KEY",
    "HOST_RESOURCES_CAPABILITY_KEY",
    "HOST_RESOURCES_LIST_METHOD",
    "HOST_RESOURCES_READ_METHOD",
    "INVALID_PARAMS",
    "LIFECYCLE_EVENTS",
    "LIFECYCLE_EXTENSION_ID",
    "PREVIEW_CHARS",
    "RATE_LIMITED",
    "READS",
    "RECORD_VIEW_META",
    "RESOURCE_NOT_FOUND",
    "RESPONSE_TOO_LARGE",
    "SERVER_CARD_MEDIA_TYPE",
    "SERVER_CARD_SCHEMA",
    "SKILLS_EXTENSION_ID",
    "ErrorContractMiddleware",
    "FacetLevel",
    "HostCapabilityMissing",
    "HostResources",
    "LifecycleEvent",
    "LifecycleExtension",
    "MCPServerSkillsExtension",
    "Placement",
    "PlatformExtension",
    "SkillDefinition",
    "SkillsExtension",
    "add_error_contract",
    "add_lifecycle_extension",
    "add_platform_extension",
    "add_server_card",
    "add_skills",
    "announce_resource_list_changed",
    "facet_count",
    "facet_meta",
    "host",
    "lifecycle_meta",
    "listing_row",
    "new_prefixed_id",
    "new_ulid",
    "preview_text",
    "record_view_meta",
]

__version__ = _version("nimblebrain-server-sdk")
