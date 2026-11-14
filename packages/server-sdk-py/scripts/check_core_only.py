"""Check the SDK on an install with neither extra.

Usage: ``python scripts/check_core_only.py``, in an environment where
``nimblebrain-server-sdk`` is installed without ``[db]`` or ``[observability]``. Exits non-zero,
naming each problem, unless the core and its error contract import and work, and each optional
subpackage refuses with an ``ImportError`` that names its extra. CI runs it on a fresh install
of the package and of the built wheel.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys

EXTRAS = {
    "db": ("pgbulkhead", "sqlalchemy", "asyncpg"),
    "observability": ("prometheus_client", "structlog", "opentelemetry.sdk"),
    # `[outbox]` is `[db]` and `[observability]` together, so it installs nothing of its own.
    "outbox": ("pgbulkhead", "sqlalchemy", "prometheus_client"),
}


def main() -> list[str]:
    problems: list[str] = []

    for extra, modules in EXTRAS.items():
        for module in modules:
            try:
                present = importlib.util.find_spec(module) is not None
            except ModuleNotFoundError:
                present = False
            if present:
                problems.append(
                    f"{module} ([{extra}]) is installed; this check needs neither extra"
                )
    if problems:
        return problems

    import nimblebrain_server_sdk  # noqa: F401
    from nimblebrain_server_sdk.errors import (
        ErrorCode,
        HostCapabilityMissing,  # noqa: F401
        ServiceError,
        rate_limited_tool_error,
        to_tool_error,
    )

    result = to_tool_error(ServiceError.from_upstream(429))
    if not result.is_error or result.structured_content["error"]["code"] != ErrorCode.RATE_LIMITED:
        problems.append(f"to_tool_error returned {result!r}")

    class Refusal:
        message = "At capacity."
        next_step = "Retry shortly."

    if not rate_limited_tool_error(Refusal()).is_error:
        problems.append("rate_limited_tool_error did not return an error result")

    for extra in EXTRAS:
        subpackage = f"nimblebrain_server_sdk.{extra}"
        try:
            importlib.import_module(subpackage)
        except ImportError as exc:
            if f"pip install 'nimblebrain-server-sdk[{extra}]'" not in str(exc):
                problems.append(f"{subpackage}: ImportError does not name the extra: {exc}")
        else:
            problems.append(f"{subpackage} imported without the [{extra}] extra")

    return problems


if __name__ == "__main__":
    found = main()
    for problem in found:
        print(f"::error::{problem}")
    if found:
        sys.exit(1)
    print("core-only install ok")
