"""The SDK's side of the host-parity cases in ``fixtures/host_parity.json``.

The host drops an envelope it cannot hold and its poll moves past it, so an envelope ``emit``
accepts and the host drops is a lost notification. Each case records the SDK's verdict
(``sdk``) and the host parser's (``host``). This suite asserts the SDK's, and that the
occurrence the poll renders for an accepted case is exactly the case's envelope plus a cursor,
which is how the runtime's ``test/unit/notifications/server-sdk-parity.test.ts`` builds what it
hands the host parser. That test asserts the host's verdict and that every case the SDK accepts,
the host keeps.

The cursor in the rendered occurrence is replaced with one of the host's maximum length: real
cursors are shorter, so it is the size a host could ever measure.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from nimblebrain_server_sdk.outbox import core
from nimblebrain_server_sdk.outbox.cursor import MAX_CURSOR_LENGTH
from nimblebrain_server_sdk.outbox.envelope import EnvelopeError, validate

CASES: list[dict[str, Any]] = json.loads(
    (Path(__file__).parent / "fixtures" / "host_parity.json").read_text(encoding="utf-8")
)


def written(case: dict[str, Any]) -> dict[str, Any]:
    """The envelope as a server writes it, with ``pad`` bytes of ``data["s"]`` when set."""
    envelope = dict(case["envelope"])
    if "pad" in case:
        envelope["data"] = {**envelope["data"], "s": "a" * case["pad"]}
    return envelope


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["case"])
def test_the_sdk_verdict_matches_the_case(case: dict[str, Any]) -> None:
    if case["sdk"] == "refuse":
        with pytest.raises(EnvelopeError):
            validate(written(case))
        return
    checked = validate(written(case))
    row = SimpleNamespace(
        event_id=checked.event_id,
        name=checked.name,
        timestamp=checked.timestamp,
        data=checked.data,
        meta=checked.meta,
        txid=5,
        seq=7,
    )
    occurrence = core._occurrence(row, "epoch", 10)
    occurrence["cursor"] = "x" * MAX_CURSOR_LENGTH
    assert occurrence == {**written(case), "cursor": "x" * MAX_CURSOR_LENGTH}


def test_no_case_is_accepted_here_and_dropped_there() -> None:
    lost = [c["case"] for c in CASES if c["sdk"] == "accept" and c["host"] == "drop"]
    assert lost == []
