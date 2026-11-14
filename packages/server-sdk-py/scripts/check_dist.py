"""Check what a build of nimblebrain-server-sdk ships, before it is published.

Usage: ``python scripts/check_dist.py <dist-dir>``. Exits non-zero, naming each problem, when
the wheel or the sdist in ``dist-dir`` is missing something a user needs or carries something
that is only local tooling. CI runs it on every change to the package, and the release workflow
runs it on the exact files it publishes.
"""

from __future__ import annotations

import sys
import tarfile
import tomllib
import zipfile
from email.parser import HeaderParser
from pathlib import Path

PACKAGE = "nimblebrain_server_sdk"
LICENSE = "Apache-2.0"
REQUIRES_PYTHON = ">=3.13"
# The optional parts: `db`, `observability` and `outbox`, each a subpackage the core never imports.
EXTRAS = {"db", "observability", "outbox"}
# The repository's tooling around the package, not part of it. (Hatchling adds .gitignore to
# every sdist itself, so it is not listed.)
SDIST_EXCLUDED = ("uv.lock", "uv.toml")


def main(dist: Path) -> list[str]:
    problems: list[str] = []
    version = tomllib.loads(Path("pyproject.toml").read_text())["project"]["version"]

    wheels = sorted(dist.glob("*.whl"))
    sdists = sorted(dist.glob("*.tar.gz"))
    if len(wheels) != 1 or len(sdists) != 1:
        return [f"expected one wheel and one sdist in {dist}, found {wheels + sdists}"]

    with zipfile.ZipFile(wheels[0]) as wheel:
        names = set(wheel.namelist())
        if f"{PACKAGE}/py.typed" not in names:
            problems.append("wheel: no py.typed, so type checkers treat the package as untyped")
        if not any(n.endswith(".dist-info/licenses/LICENSE") for n in names):
            problems.append("wheel: LICENSE is not in .dist-info/licenses/")
        if any(n.startswith("tests/") for n in names):
            problems.append("wheel: carries tests/")
        metadata_name = next(n for n in names if n.endswith(".dist-info/METADATA"))
        metadata = HeaderParser().parsestr(wheel.read(metadata_name).decode())
        if metadata["Version"] != version:
            problems.append(f"wheel: Version {metadata['Version']} != pyproject {version}")
        if metadata["License-Expression"] != LICENSE:
            problems.append(f"wheel: License-Expression {metadata['License-Expression']!r}")
        if metadata["Requires-Python"] != REQUIRES_PYTHON:
            problems.append(f"wheel: Requires-Python {metadata['Requires-Python']!r}")
        extras = set(metadata.get_all("Provides-Extra") or ())
        if extras != EXTRAS:
            problems.append(f"wheel: Provides-Extra {sorted(extras)} != {sorted(EXTRAS)}")

    with tarfile.open(sdists[0]) as sdist:
        members = {Path(m.name).relative_to(Path(m.name).parts[0]).as_posix() for m in sdist}
        for excluded in SDIST_EXCLUDED:
            if excluded in members:
                problems.append(f"sdist: carries {excluded}")
        for required in ("LICENSE", "pyproject.toml", f"src/{PACKAGE}/py.typed"):
            if required not in members:
                problems.append(f"sdist: missing {required}")

    return problems


if __name__ == "__main__":
    found = main(Path(sys.argv[1]))
    for problem in found:
        print(f"::error::{problem}")
    if found:
        sys.exit(1)
    print("dist ok")
