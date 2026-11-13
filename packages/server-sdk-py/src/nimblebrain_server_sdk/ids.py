"""The opaque record id a server mints: ``<prefix>_<ulid>``.

A record id is a public contract, so it is

  * **Opaque.** No sequence number or row id: the body is a ULID, a millisecond timestamp
    in its high bits and randomness in its low bits, so it reveals neither row counts nor
    another tenant's ordering.
  * **Never recycled.** Every mint is a fresh ULID, so a stale reference never resolves to
    a different record.
  * **Sortable.** The leading 48 bits are the mint time, so a later id sorts lexically after
    an earlier one. That is an ordering convenience, not a uniqueness guarantee: uniqueness
    comes from the 80 random bits and the table's primary key.

A ULID here is 26 characters of Crockford base32 (``0-9`` and ``A-Z`` without ``I L O U``),
minted from ``time`` and ``os.urandom`` with no third-party dependency. Within one
millisecond the random part is incremented rather than redrawn, and a clock that steps
backwards holds at the last millisecond, so ids minted in a tight loop, from any thread,
keep strictly increasing. One lock guards that state for the whole process.

A server keeps its own prefixes and builds its named minters on :func:`new_prefixed_id`::

    THING_PREFIX = "th"

    def new_thing_id() -> str:
        return new_prefixed_id(THING_PREFIX)
"""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable

__all__ = [
    "CROCKFORD_ALPHABET",
    "ULID_LENGTH",
    "new_prefixed_id",
    "new_ulid",
]

CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
"""The ULID alphabet, in ascending ASCII order, so string order is numeric order."""

ULID_LENGTH = 26
"""Characters in a ULID: 10 of timestamp and 16 of randomness, 5 bits each."""

_TIME_BITS = 48
_TIME_MAX = (1 << _TIME_BITS) - 1
_RANDOM_BITS = 80
_RANDOM_MAX = (1 << _RANDOM_BITS) - 1


def _encode(value: int, length: int) -> str:
    """``value`` as a fixed-``length`` Crockford base32 string, most significant first."""
    chars = ["0"] * length
    for i in range(length - 1, -1, -1):
        chars[i] = CROCKFORD_ALPHABET[value & 0x1F]
        value >>= 5
    return "".join(chars)


def _draw() -> int:
    return int.from_bytes(os.urandom(_RANDOM_BITS // 8), "big")


class _Minter:
    """Monotonic ULID state behind one lock. The clock is a parameter so tests can hold it."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._last_ms = -1
        self._last_random = 0

    def mint(self) -> str:
        with self._lock:
            now_ms = max(int(self._clock() * 1000), self._last_ms)
            if now_ms == self._last_ms:
                # The same millisecond, or a clock that stepped back: increment, never redraw,
                # so the id still sorts after the last one. An 80-bit overflow spills into the
                # next millisecond.
                candidate = self._last_random + 1
                if candidate > _RANDOM_MAX:
                    now_ms += 1
                    candidate = _draw()
            else:
                candidate = _draw()
            self._last_ms = now_ms
            self._last_random = candidate
        return _encode(now_ms & _TIME_MAX, 10) + _encode(candidate & _RANDOM_MAX, 16)


_MINTER = _Minter()


def new_ulid() -> str:
    """One fresh ULID, strictly greater than every ULID minted before it in this process."""
    return _MINTER.mint()


def new_prefixed_id(prefix: str) -> str:
    """``<prefix>_<ulid>``: an opaque record id whose prefix names the record's kind."""
    return f"{prefix}_{new_ulid()}"
