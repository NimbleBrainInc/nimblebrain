"""The reference generator's build-failure guarantees.

Each test writes a small package named like the SDK into a temporary directory and points the
generator at it, so a failure here is about the generator and not about the SDK's docstrings.

    bun run test:reference
"""

from __future__ import annotations

from pathlib import Path

import pytest
import server_sdk_reference as reference

PAGES = [("", "core", reference.PACKAGE, "fixture", "A fixture module.")]

DOCUMENTED = '''\
"""A fixture module."""

__all__ = ["Thing", "make"]


class Thing:
    """A thing."""


def make() -> Thing:
    """Make a thing."""
    return Thing()
'''


def _package(tmp_path: Path, source: str) -> Path:
    package_dir = tmp_path / "package"
    module_dir = package_dir / "src" / reference.PACKAGE
    module_dir.mkdir(parents=True)
    (package_dir / "pyproject.toml").write_text(
        '[project]\nname = "fixture"\nversion = "1.2.3"\n'
    )
    (module_dir / "__init__.py").write_text(source, encoding="utf-8")
    return package_dir


def test_documented_package_writes_its_pages(tmp_path: Path) -> None:
    out = tmp_path / "out"

    assert reference.main(_package(tmp_path, DOCUMENTED), out, PAGES) == 0

    assert sorted(page.name for page in out.iterdir()) == ["core.md", "index.md"]
    core = (out / "core.md").read_text(encoding="utf-8")
    assert "### `Thing`" in core
    assert "Make a thing." in core
    assert "version 1.2.3" in core


def test_unicode_docstrings_and_summaries_are_written_as_utf8(tmp_path: Path) -> None:
    out = tmp_path / "out"
    source = DOCUMENTED.replace('"""A thing."""', '"""A thing ∪ another."""')
    pages = [("", "core", reference.PACKAGE, "fixture", "A fixture ∪ another.")]

    assert reference.main(_package(tmp_path, source), out, pages) == 0
    assert "A thing ∪ another." in (out / "core.md").read_text(encoding="utf-8")
    assert "A fixture ∪ another." in (out / "index.md").read_text(encoding="utf-8")


@pytest.mark.parametrize(
    ("documented", "undocumented", "name"),
    [
        (
            'def make() -> Thing:\n    """Make a thing."""\n',
            "def make() -> Thing:\n",
            "make",
        ),
        ('class Thing:\n    """A thing."""\n', "class Thing:\n    pass\n", "Thing"),
    ],
    ids=["function", "class"],
)
def test_public_name_without_a_docstring_fails_the_build(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    documented: str,
    undocumented: str,
    name: str,
) -> None:
    assert documented in DOCUMENTED
    source = DOCUMENTED.replace(documented, undocumented)

    assert reference.main(_package(tmp_path, source), tmp_path / "out", PAGES) == 1

    assert (
        f"error: {reference.PACKAGE}.{name} has no docstring" in capsys.readouterr().err
    )


@pytest.mark.parametrize(
    ("source", "name"),
    [
        (
            DOCUMENTED.replace('["Thing", "make"]', '["Thing", "make", "absent"]'),
            "absent",
        ),
        (
            DOCUMENTED.replace(
                '__all__ = ["Thing", "make"]',
                "from package_that_is_not_installed import gone\n\n"
                '__all__ = ["Thing", "gone", "make"]',
            ),
            "gone",
        ),
    ],
    ids=["name-not-defined", "import-not-installed"],
)
def test_export_that_cannot_be_resolved_fails_the_build(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], source: str, name: str
) -> None:
    assert name in source

    assert reference.main(_package(tmp_path, source), tmp_path / "out", PAGES) == 1

    assert (
        f"error: {reference.PACKAGE}.{name} cannot be resolved"
        in capsys.readouterr().err
    )


def test_module_without_exports_fails_the_build(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    source = DOCUMENTED.replace('__all__ = ["Thing", "make"]\n', "")

    assert reference.main(_package(tmp_path, source), tmp_path / "out", PAGES) == 1

    assert f"error: {reference.PACKAGE} has no __all__" in capsys.readouterr().err
