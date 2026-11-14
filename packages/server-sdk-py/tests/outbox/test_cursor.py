"""The cursor codec.

Everything a cursor cannot honour raises the same recoverable error, because
the caller's response to all of them is the same: answer ``truncated: true``
with a fresh cursor and whatever is retained.
"""

from __future__ import annotations

import pytest

from nimblebrain_server_sdk.outbox.cursor import MAX_CURSOR_LENGTH, Cursor, CursorError, decode

EPOCH = "6f1d9f5e-0d2f-4a1e-9b7c-1a2b3c4d5e6f"


def test_round_trips_a_bare_watermark() -> None:
    assert decode(Cursor(EPOCH, 4211).encode(), epoch=EPOCH) == Cursor(EPOCH, 4211)


def test_round_trips_the_above_horizon_marker() -> None:
    """The rows the answering transaction wrote itself, and how far they went."""
    original = Cursor(EPOCH, 4211, 4300, 97)
    assert decode(original.encode(), epoch=EPOCH) == original


def test_is_opaque_on_the_wire() -> None:
    """No caller should be able to read a position out of it, or fabricate one."""
    encoded = Cursor(EPOCH, 4211).encode()
    assert "4211" not in encoded
    assert EPOCH not in encoded


def test_a_cursor_from_another_epoch_is_refused() -> None:
    """A restored database keeps the rows and resets the counter underneath them."""
    with pytest.raises(CursorError, match="epoch"):
        decode(Cursor("00000000-0000-0000-0000-000000000000", 4211).encode(), epoch=EPOCH)


@pytest.mark.parametrize(
    "value",
    [
        "",
        "not-a-cursor",
        "nbo1:!!!!",
        "nbo1:" + "eyJhIjoxfQ",  # decodable base64, wrong shape
    ],
)
def test_anything_undecodable_is_refused(value: str) -> None:
    with pytest.raises(CursorError):
        decode(value, epoch=EPOCH)


def test_an_over_long_cursor_is_refused_before_it_is_parsed() -> None:
    with pytest.raises(CursorError, match="longer"):
        decode("nbo1:" + "A" * MAX_CURSOR_LENGTH, epoch=EPOCH)


def test_a_negative_watermark_is_not_a_transaction_id() -> None:
    with pytest.raises(CursorError, match="transaction id"):
        decode(Cursor(EPOCH, -1).encode(), epoch=EPOCH)
