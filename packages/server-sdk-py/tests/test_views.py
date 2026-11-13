"""``record_view_meta``: a record template names the view that shows it."""

from __future__ import annotations

import pytest

from nimblebrain_server_sdk import RECORD_VIEW_META, record_view_meta


def test_the_meta_holds_the_view_under_the_key():
    assert record_view_meta("ui://acme/boards") == {RECORD_VIEW_META: "ui://acme/boards"}
    assert RECORD_VIEW_META == "ai.nimblebrain/view"


@pytest.mark.parametrize("bad", ["", "ui://", "acme://boards", "https://example.test/view"])
def test_anything_but_a_ui_uri_is_refused(bad: str):
    with pytest.raises(ValueError):
        record_view_meta(bad)
