"""The record id minter: format, order within a millisecond, and order across threads."""

from __future__ import annotations

import threading

from nimblebrain_server_sdk import ids
from nimblebrain_server_sdk.ids import CROCKFORD_ALPHABET, ULID_LENGTH, new_prefixed_id, new_ulid

_ALPHABET = set(CROCKFORD_ALPHABET)


def _decode(ulid: str) -> tuple[int, int]:
    """``(timestamp_ms, random)`` of a ULID."""
    value = 0
    for char in ulid:
        value = value * 32 + CROCKFORD_ALPHABET.index(char)
    return value >> 80, value & ((1 << 80) - 1)


def test_alphabet_is_crockford_in_ascii_order() -> None:
    assert CROCKFORD_ALPHABET == "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    assert not set("ILOU") & _ALPHABET
    assert list(CROCKFORD_ALPHABET) == sorted(CROCKFORD_ALPHABET)


def test_ulid_is_26_crockford_characters() -> None:
    ulid = new_ulid()
    assert len(ulid) == ULID_LENGTH == 26
    assert set(ulid) <= _ALPHABET
    # 128 bits in 130: the two leading bits are always zero.
    assert ulid[0] in "01234567"


def test_prefixed_id_is_prefix_underscore_ulid() -> None:
    value = new_prefixed_id("ex_kind")
    prefix, _, body = value.rpartition("_")
    assert prefix == "ex_kind"
    assert len(body) == ULID_LENGTH
    assert set(body) <= _ALPHABET


def test_timestamp_is_the_mint_millisecond() -> None:
    minter = ids._Minter(clock=lambda: 1_700_000_000.123)
    assert _decode(minter.mint())[0] == 1_700_000_000_123


def test_same_millisecond_increments_the_random_part() -> None:
    minter = ids._Minter(clock=lambda: 1_700_000_000.0)
    minted = [minter.mint() for _ in range(1000)]
    assert minted == sorted(minted)
    assert len(set(minted)) == len(minted)
    decoded = [_decode(u) for u in minted]
    assert {ms for ms, _ in decoded} == {1_700_000_000_000}
    randoms = [r for _, r in decoded]
    assert randoms == list(range(randoms[0], randoms[0] + 1000))


def test_clock_stepping_back_holds_the_last_millisecond() -> None:
    now = [1_700_000_000.5]
    minter = ids._Minter(clock=lambda: now[0])
    first = minter.mint()
    now[0] -= 10
    second = minter.mint()
    assert second > first
    assert _decode(second)[0] == _decode(first)[0]
    assert _decode(second)[1] == _decode(first)[1] + 1


def test_random_overflow_spills_into_the_next_millisecond() -> None:
    minter = ids._Minter(clock=lambda: 1_700_000_000.0)
    first = minter.mint()
    minter._last_random = (1 << 80) - 1
    second = minter.mint()
    assert second > first
    assert _decode(second)[0] == _decode(first)[0] + 1


def test_a_new_millisecond_redraws() -> None:
    now = [1_700_000_000.0]
    minter = ids._Minter(clock=lambda: now[0])
    first = minter.mint()
    now[0] += 0.001
    second = minter.mint()
    assert _decode(second)[0] == _decode(first)[0] + 1
    assert second > first


def test_concurrent_mints_are_unique_and_ordered_per_thread() -> None:
    per_thread: dict[int, list[str]] = {}
    barrier = threading.Barrier(8)

    def mint(n: int) -> None:
        barrier.wait()
        per_thread[n] = [new_ulid() for _ in range(2000)]

    threads = [threading.Thread(target=mint, args=(n,)) for n in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    everything = [u for minted in per_thread.values() for u in minted]
    assert len(set(everything)) == len(everything) == 8 * 2000
    for minted in per_thread.values():
        assert minted == sorted(minted)
