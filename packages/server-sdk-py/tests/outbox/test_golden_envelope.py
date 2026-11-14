"""Golden: the envelope's constants and the ``_meta`` block ``emit`` builds.

The limits and the level vocabulary are the server half of a host protocol: the
host applies the same numbers, so a value accepted here and trimmed there means
the text an operator reads is not the text the server wrote. The block built
from the keywords is what every host renders and routes on.

``tests/golden/envelope.json`` is frozen output with no regenerate path.
"""

from __future__ import annotations

import json
from pathlib import Path

import nimblebrain_server_sdk.outbox as notify_outbox
from nimblebrain_server_sdk.outbox import envelope as env

GOLDEN = json.loads((Path(__file__).parent / "golden" / "envelope.json").read_text())


def test_constants_match_golden() -> None:
    actual = {
        "NOTIFICATION_META_KEY": env.NOTIFICATION_META_KEY,
        "LEVELS": list(env.LEVELS),
        "DEFAULT_LEVEL": env.DEFAULT_LEVEL,
        "TITLE_MAX": env.TITLE_MAX,
        "BODY_MAX": env.BODY_MAX,
        "SUBJECT_MAX": env.SUBJECT_MAX,
        "LINK_MAX": env.LINK_MAX,
        "NAME_MAX": env.NAME_MAX,
        "EVENT_ID_MAX": env.EVENT_ID_MAX,
        "ENVELOPE_MAX_BYTES": env.ENVELOPE_MAX_BYTES,
        "FORBIDDEN_LINK_SCHEMES": sorted(env.FORBIDDEN_LINK_SCHEMES),
        "MAX_CURSOR_LENGTH": notify_outbox.MAX_CURSOR_LENGTH,
        "DEFAULT_MAX_EVENTS": notify_outbox.DEFAULT_MAX_EVENTS,
        "MAX_MAX_EVENTS": notify_outbox.MAX_MAX_EVENTS,
        "DEFAULT_MAX_ROWS": notify_outbox.DEFAULT_MAX_ROWS,
        "DEFAULT_TABLE_NAME": notify_outbox.DEFAULT_TABLE_NAME,
        "RETENTION_SECONDS": notify_outbox.RETENTION.total_seconds(),
        "MAX_AGE_MS_CEILING": notify_outbox.MAX_AGE_MS_CEILING,
    }
    assert actual == GOLDEN["constants"]


def test_keywords_build_the_golden_block() -> None:
    checked = env.validate(
        {
            "eventId": "evt_1",
            "name": "domain.active",
            "timestamp": "2026-01-02T03:04:05+10:00",
            "data": {"domain": "example.com"},
            "_meta": {"com.example/other": {"k": 1}},
        },
        title="example.com is active",
        level="attention",
        subject="example.com",
        body="DNS propagated.",
        link_resource="acme://domains/1",
    )
    # Compared as serialized text, so key order is pinned too.
    assert json.dumps(checked.meta) == json.dumps(GOLDEN["meta_from_keywords"])


def test_a_title_alone_takes_the_default_level() -> None:
    checked = env.validate(
        {
            "eventId": "evt_2",
            "name": "reply.received",
            "timestamp": "2026-01-02T03:04:05Z",
            "data": {},
        },
        title="t",
    )
    assert json.dumps(checked.meta) == json.dumps(GOLDEN["meta_from_title_only"])
