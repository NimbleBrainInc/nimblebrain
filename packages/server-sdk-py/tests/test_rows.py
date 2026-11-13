"""A listing row is the record bounded: unbounded text dropped or previewed, its address kept."""

from __future__ import annotations

import re

import pytest

from nimblebrain_server_sdk import PREVIEW_CHARS, listing_row, preview_text
from nimblebrain_server_sdk.testing import assert_bounded_rows

LONG = "word " * 2_000


def _record(**fields: object) -> dict[str, object]:
    return {"id": "r1", "uri": "probe://things/r1", "name": "Thing", **fields}


def test_short_text_is_its_own_preview():
    assert preview_text("short") == "short"
    assert preview_text("x" * PREVIEW_CHARS) == "x" * PREVIEW_CHARS


def test_long_text_is_cut_to_the_limit_and_says_so():
    cut = preview_text(LONG, 40)
    assert len(cut) <= 40
    assert cut.endswith("…")
    assert LONG.startswith(cut[:-1])


def test_a_preview_holds_at_least_one_character():
    with pytest.raises(ValueError, match="at least one character"):
        preview_text("text", 0)


def test_omitted_fields_leave_and_the_rest_stay():
    record = _record(summary=LONG, summary_updated_at="2026-10-01")
    row = listing_row(record, omit=("summary",))
    assert row == _record(summary_updated_at="2026-10-01")
    assert record["summary"] == LONG, "the record itself is not modified"


def test_a_previewed_field_comes_back_under_its_own_name():
    row = listing_row(_record(content=LONG), preview={"content": 80})
    assert "content" not in row
    assert len(row["content_preview"]) <= 80
    assert row["uri"] == "probe://things/r1"


def test_an_absent_or_empty_field_is_tolerated():
    assert listing_row(_record(), omit=("summary",), preview={"details": 80}) == _record()
    assert listing_row(_record(details=None), preview={"details": 80})["details_preview"] is None


def test_a_non_text_preview_is_a_server_bug():
    with pytest.raises(TypeError):
        listing_row(_record(details={"nested": LONG}), preview={"details": 80})


def test_a_bounded_page_passes():
    rows = [
        listing_row(_record(id=f"r{i}", uri=f"probe://things/r{i}", body=LONG), omit=("body",))
        for i in range(3)
    ]
    assert_bounded_rows(rows, unbounded=("body",))


@pytest.mark.parametrize(
    ("rows", "message"),
    [
        ([], "empty page"),
        ([{"id": "r1", "name": "Thing"}], "no uri"),
        ([_record(summary="# short")], "carries ['summary']"),
        ([_record(notes=LONG)], "row 0.notes"),
        ([_record(tags=[{"label": LONG}])], "row 0.tags[0].label"),
    ],
)
def test_an_unbounded_or_unaddressed_page_fails(rows, message):
    with pytest.raises(AssertionError, match=re.escape(message)):
        assert_bounded_rows(rows, unbounded=("summary",))
