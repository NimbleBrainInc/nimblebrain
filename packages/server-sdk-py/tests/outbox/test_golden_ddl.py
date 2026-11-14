"""Golden: the SQL ``outbox_ddl`` renders, byte for byte.

Historic migrations call ``outbox_ddl`` rather than holding their SQL, so a
change here rewrites what a replayed migration creates: the two tables, their
indexes and the RLS policy on both. Pinned for every table name a consumer
passes (only the default, today) and one renamed table, which exercises every
place the name is threaded through.

``tests/golden/ddl.json`` is frozen output with no regenerate path.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import sqlalchemy as sa

from nimblebrain_server_sdk.outbox import outbox_ddl, outbox_table

GOLDEN = json.loads((Path(__file__).parent / "golden" / "ddl.json").read_text())


@pytest.mark.parametrize("name", sorted(GOLDEN))
def test_rendered_ddl_matches_golden(name: str) -> None:
    assert outbox_ddl(outbox_table(sa.MetaData(), name)) == GOLDEN[name]


def test_the_default_table_is_pinned() -> None:
    assert outbox_ddl(outbox_table(sa.MetaData())) == GOLDEN["notification_outbox"]
