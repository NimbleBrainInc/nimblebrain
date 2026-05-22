"""Python SDK for NimbleBrain MCP bundles.

Wraps the `ai.nimblebrain/host-resources` extension so bundle code can
read workspace files through the platform without filesystem access.
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

__all__ = [
    "HOST_RESOURCES_CAPABILITY_KEY",
    "HOST_RESOURCES_LIST_METHOD",
    "HOST_RESOURCES_READ_METHOD",
    "INVALID_PARAMS",
    "RATE_LIMITED",
    "RESOURCE_NOT_FOUND",
    "RESPONSE_TOO_LARGE",
    "HostCapabilityMissing",
    "HostResources",
    "host",
]

__version__ = "0.1.0"
