"""The public surface of this library, as data, for ``test_golden_api``.

Kept apart from the test so the shape it reads is one function: every name in
``__all__``, every name a consumer imports from a submodule, the parameters of
each callable (name, kind, default), dataclass fields, and the exception
hierarchy. Parameters rather than annotation strings: an annotation moves
legitimately when a type is re-exported from elsewhere, a parameter does not.
"""

from __future__ import annotations

import dataclasses
import inspect
from typing import Any

import nimblebrain_server_sdk.outbox as notify_outbox
from nimblebrain_server_sdk.outbox import cursor, envelope, fastmcp, metrics

#: Names consumers import from a submodule rather than the package. Found by#: grepping every consumer for ``from <package>.<module> import`` and the attribute reads on
#: ``envelope`` in their tests.
SUBMODULE_NAMES: dict[str, tuple[Any, tuple[str, ...]]] = {
    "cursor": (cursor, ("Cursor", "CursorError", "MAX_CURSOR_LENGTH", "decode")),
    "envelope": (
        envelope,
        (
            "BODY_MAX",
            "DEFAULT_LEVEL",
            "ENVELOPE_MAX_BYTES",
            "EVENT_ID_MAX",
            "EnvelopeError",
            "FORBIDDEN_LINK_SCHEMES",
            "LEVELS",
            "LINK_MAX",
            "NAME_MAX",
            "NOTIFICATION_META_KEY",
            "SUBJECT_MAX",
            "TITLE_MAX",
            "ValidatedEnvelope",
            "validate",
        ),
    ),
    "fastmcp": (fastmcp, ("register_outbox",)),
    "metrics": (metrics, ("CAPPED", "DEPTH", "EMITTED", "READ")),
}


def _default(value: Any) -> Any:
    if value is inspect.Parameter.empty:
        return "<required>"
    return repr(value)


def _describe(obj: Any) -> Any:
    if inspect.isclass(obj) and issubclass(obj, BaseException):
        return {"exception": [base.__name__ for base in obj.__mro__[1:-1]]}
    if dataclasses.is_dataclass(obj) and inspect.isclass(obj):
        return {
            "dataclass": [
                [
                    f.name,
                    _default(
                        f.default
                        if f.default is not dataclasses.MISSING
                        else inspect.Parameter.empty
                    ),
                ]
                for f in dataclasses.fields(obj)
            ]
        }
    if inspect.isfunction(obj):
        return {
            "params": [
                [p.name, p.kind.name, _default(p.default)]
                for p in inspect.signature(obj).parameters.values()
            ]
        }
    if hasattr(obj, "_name") and hasattr(obj, "_type"):  # a prometheus metric
        return {"metric": [obj._name, obj._type, list(obj._labelnames)]}
    if isinstance(obj, frozenset | set):
        # Sorted: a set's repr follows string hashing, which is randomized per process.
        return {"set": sorted(obj)}
    return {"value": repr(obj)}


def surface() -> dict[str, Any]:
    return {
        "__all__": sorted(notify_outbox.__all__),
        "package": {
            name: _describe(getattr(notify_outbox, name)) for name in sorted(notify_outbox.__all__)
        },
        "submodules": {
            module_name: {name: _describe(getattr(module, name)) for name in names}
            for module_name, (module, names) in SUBMODULE_NAMES.items()
        },
    }
