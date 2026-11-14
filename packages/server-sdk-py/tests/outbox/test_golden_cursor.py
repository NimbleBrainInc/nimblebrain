"""Golden: the cursor's wire form.

A host stores the cursor between polls and hands it back, so the encoding is a
format other systems hold. A change to it strands every cursor in flight: each
would read as foreign and replay as ``truncated``. Pinned both ways: these
fields encode to exactly these strings, and these strings decode to exactly
these fields.

``tests/golden/cursors.json`` is frozen output with no regenerate path.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from nimblebrain_server_sdk.outbox.cursor import Cursor, decode

GOLDEN: list[dict[str, Any]] = json.loads(
    (Path(__file__).parent / "golden" / "cursors.json").read_text()
)


def _cursor(case: dict[str, Any]) -> Cursor:
    return Cursor(case["epoch"], case["watermark"], case["extra_txid"], case["extra_seq"])


@pytest.mark.parametrize("case", GOLDEN, ids=lambda case: case["wire"][:24])
def test_encodes_to_golden(case: dict[str, Any]) -> None:
    assert _cursor(case).encode() == case["wire"]


@pytest.mark.parametrize("case", GOLDEN, ids=lambda case: case["wire"][:24])
def test_golden_decodes_to_its_fields(case: dict[str, Any]) -> None:
    assert decode(case["wire"], epoch=case["epoch"]) == _cursor(case)
