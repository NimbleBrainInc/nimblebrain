"""The README's Python is the tested examples, byte for byte.

Every ``python`` block in the README is preceded by ``<!-- example: examples/<file> -->`` and
must equal that file. The files themselves are linted, type-checked and run by this suite
(``examples/test_*.py``), so a snippet a reader copies is one that ran.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).parent.parent
BLOCK = re.compile(r"(?:<!-- example: (?P<path>\S+) -->\n)?```python\n(?P<code>.*?)```", re.DOTALL)


def test_every_python_block_is_a_tested_example() -> None:
    blocks = list(BLOCK.finditer((ROOT / "README.md").read_text()))
    assert blocks, "the README shows no Python"
    shown = set()
    for block in blocks:
        path = block["path"]
        assert path, f"a python block names no example file:\n{block['code'][:200]}"
        assert path.startswith("examples/"), path
        assert block["code"] == (ROOT / path).read_text(), f"README block differs from {path}"
        shown.add(path)
    # Each shown server has a test that the suite collects, and that test is shown too.
    assert {"examples/notes.py", "examples/test_notes.py"} <= shown
    assert {"examples/db_notes.py", "examples/test_db_notes.py"} <= shown
    for path in shown:
        name = Path(path).name
        if not name.startswith("test_") and name != "db_migrate.py":
            assert (ROOT / "examples" / f"test_{name}").exists(), f"{path} has no test"
