"""Python SDK for NimbleBrain MCP bundles.

Wraps the `ai.nimblebrain/host-resources` extension so bundle code can
read workspace files through the platform without filesystem access, and
serves skills through the MCP Skills extension (`io.modelcontextprotocol/skills`).
"""

from nimblebrain_bundle_sdk.errors import HostCapabilityMissing
from nimblebrain_bundle_sdk.host import HostResources, host
from nimblebrain_bundle_sdk.methods import (
    HOST_RESOURCES_CAPABILITY_KEY,
    HOST_RESOURCES_LIST_METHOD,
    HOST_RESOURCES_READ_METHOD,
    INVALID_PARAMS,
    RATE_LIMITED,
    RESOURCE_NOT_FOUND,
    RESPONSE_TOO_LARGE,
)
from nimblebrain_bundle_sdk.skills import (
    SKILLS_EXTENSION_ID,
    MCPServerSkillsExtension,
    SkillDefinition,
    SkillsExtension,
)

__all__ = [
    "HOST_RESOURCES_CAPABILITY_KEY",
    "HOST_RESOURCES_LIST_METHOD",
    "HOST_RESOURCES_READ_METHOD",
    "INVALID_PARAMS",
    "RATE_LIMITED",
    "RESOURCE_NOT_FOUND",
    "RESPONSE_TOO_LARGE",
    "SKILLS_EXTENSION_ID",
    "HostCapabilityMissing",
    "HostResources",
    "MCPServerSkillsExtension",
    "SkillDefinition",
    "SkillsExtension",
    "host",
]

__version__ = "0.2.0"
