"""The guard an optional subpackage runs before it imports its extra's dependencies.

``nimblebrain_server_sdk.db`` and ``nimblebrain_server_sdk.observability`` need the packages
their extra installs. Imported without them, each raises :class:`MissingExtraError`, an
``ImportError`` whose message names the extra to install, rather than a bare
``ModuleNotFoundError`` for whichever dependency happened to be imported first.
"""

from __future__ import annotations

import importlib

__all__ = ["MissingExtraError", "require_extra"]


class MissingExtraError(ImportError):
    """An optional subpackage was imported without the extra that installs its dependencies.

    ``extra`` is the extra's name. The core catches this class, and only this one, where an
    extra is optional to it (``errors`` records ``service_errors_total`` only when
    ``[observability]`` is installed), so any other import failure still surfaces.
    """

    def __init__(self, subpackage: str, extra: str, missing: str) -> None:
        super().__init__(
            f"{subpackage} needs the [{extra}] extra, which is not installed "
            f"({missing!r} is missing): pip install 'nimblebrain-server-sdk[{extra}]'",
            name=missing,
        )
        self.extra = extra


def require_extra(subpackage: str, extra: str, modules: tuple[str, ...]) -> None:
    """Import each of ``modules``; raise :class:`MissingExtraError` naming ``extra`` if one is absent.

    Only a ``ModuleNotFoundError`` for the module itself or one of its parent packages means
    the extra is absent. Any other import failure, including one raised while an installed
    module loads, is a broken install and propagates unchanged.
    """
    for module in modules:
        try:
            importlib.import_module(module)
        except ModuleNotFoundError as exc:
            if exc.name is None or not (module == exc.name or module.startswith(exc.name + ".")):
                raise
            raise MissingExtraError(subpackage, extra, module) from exc
