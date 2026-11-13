"""What an envelope has to be, and what it may never carry.

Validation raises rather than repairs (see :mod:`nimblebrain_server_sdk.outbox.envelope` for
why), so these are the failures an adopter sees in its own test run instead of
in a host's inbox three hops away.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from nimblebrain_server_sdk.outbox import ENVELOPE_MAX_BYTES, NOTIFICATION_META_KEY, EnvelopeError
from nimblebrain_server_sdk.outbox.envelope import BODY_MAX, SUBJECT_MAX, TITLE_MAX, validate

NOW = "2026-09-01T18:42:10+00:00"


def envelope(**overrides: object) -> dict:
    base = {"eventId": "evt_1", "name": "domain.active", "timestamp": NOW, "data": {"a": 1}}
    return base | overrides


def test_the_four_required_fields_round_trip() -> None:
    checked = validate(envelope())
    assert checked.event_id == "evt_1"
    assert checked.name == "domain.active"
    assert checked.timestamp == datetime(2026, 9, 1, 18, 42, 10, tzinfo=UTC)
    assert checked.data == {"a": 1}
    # No presentation block asked for and none written: still a notification,
    # which the host renders from `name`.
    assert checked.meta == {}


@pytest.mark.parametrize("field", ["eventId", "name", "timestamp", "data"])
def test_each_required_field_is_required(field: str) -> None:
    missing = envelope()
    del missing[field]
    with pytest.raises(EnvelopeError, match=field):
        validate(missing)


@pytest.mark.parametrize("value", [[], "not an object", 3, None])
def test_data_must_be_a_json_object(value: object) -> None:
    with pytest.raises(EnvelopeError, match="data"):
        validate(envelope(data=value))


def test_data_is_not_read_beyond_being_an_object() -> None:
    """Nested, oddly-named, deeply structured — none of it is this library's business."""
    payload = {"weird key": {"nested": [1, {"deeper": True}]}, "_meta": "not special here"}
    assert validate(envelope(data=payload)).data == payload


def test_data_that_is_not_serializable_fails_at_the_emit() -> None:
    with pytest.raises(EnvelopeError, match="serializable"):
        validate(envelope(data={"conn": object()}))


def test_timestamp_must_carry_an_offset() -> None:
    with pytest.raises(EnvelopeError, match="UTC offset"):
        validate(envelope(timestamp="2026-09-01T18:42:10"))


def test_timestamp_accepts_an_aware_datetime() -> None:
    moment = datetime(2026, 9, 1, 18, 42, 10, tzinfo=UTC)
    assert validate(envelope(timestamp=moment)).timestamp == moment


def test_timestamp_rejects_a_naive_datetime() -> None:
    with pytest.raises(EnvelopeError, match="UTC offset"):
        validate(envelope(timestamp=datetime(2026, 9, 1, 18, 42, 10)))


def test_fields_outside_the_contract_are_refused() -> None:
    """Not additive: the four fields plus `cursor` and `_meta` are the whole shape.

    A server improvising a top-level field is writing something no host will
    ever read, and it belongs in `data`.
    """
    with pytest.raises(EnvelopeError, match="not part of the contract"):
        validate(envelope(severity="high"))


# --------------------------------------------------------------------------- #
# The presentation block.                                                      #
# --------------------------------------------------------------------------- #


def test_keywords_build_the_meta_block() -> None:
    checked = validate(
        envelope(),
        title="acme-outreach.example is active",
        level="attention",
        subject="acme-outreach.example",
        body="DNS propagated.",
        link_resource="acme://domains/dom_1",
    )
    assert checked.meta[NOTIFICATION_META_KEY] == {
        "level": "attention",
        "title": "acme-outreach.example is active",
        "subject": "acme-outreach.example",
        "body": "DNS propagated.",
        "link": {"resource": "acme://domains/dom_1"},
    }


def test_keyword_defaults_are_the_hosts_defaults() -> None:
    block = validate(envelope(), body="something happened").meta[NOTIFICATION_META_KEY]
    assert block["level"] == "info"
    assert block["title"] == "domain.active"  # falls back to `name`


def test_a_hand_written_block_is_accepted_and_checked() -> None:
    written = {NOTIFICATION_META_KEY: {"level": "urgent", "title": "By hand"}}
    assert validate(envelope(_meta=written)).meta == written


def test_keywords_and_a_hand_written_block_together_are_refused() -> None:
    with pytest.raises(EnvelopeError, match="not both"):
        validate(envelope(_meta={NOTIFICATION_META_KEY: {"title": "x"}}), title="y")


def test_other_meta_blocks_travel_through_unread() -> None:
    """`_meta` is additive: another extension's block is carried, not policed."""
    checked = validate(envelope(_meta={"org.example/thing": {"anything": True}}), title="t")
    assert checked.meta["org.example/thing"] == {"anything": True}
    assert checked.meta[NOTIFICATION_META_KEY]["title"] == "t"


def test_level_must_be_one_of_the_three() -> None:
    with pytest.raises(EnvelopeError, match="level"):
        validate(envelope(), level="critical")


@pytest.mark.parametrize(
    ("field", "maximum"),
    [("title", TITLE_MAX), ("body", BODY_MAX), ("subject", SUBJECT_MAX)],
)
def test_plain_text_fields_are_capped_at_the_hosts_limits(field: str, maximum: int) -> None:
    validate(envelope(), **{field: "x" * maximum})
    with pytest.raises(EnvelopeError, match=field):
        validate(envelope(), **{field: "x" * (maximum + 1)})


@pytest.mark.parametrize("field", ["title", "body", "subject"])
def test_plain_text_fields_refuse_control_characters(field: str) -> None:
    """They render as one line on every surface, so a newline is never content."""
    with pytest.raises(EnvelopeError, match=field):
        validate(envelope(), **{field: "first\nsecond"})


@pytest.mark.parametrize("scheme", ["javascript", "data", "vbscript", "file", "blob"])
def test_a_link_may_not_carry_an_executable_scheme(scheme: str) -> None:
    with pytest.raises(EnvelopeError, match="scheme"):
        validate(envelope(), link_resource=f"{scheme}:whatever")


def test_a_link_must_carry_a_scheme_at_all() -> None:
    with pytest.raises(EnvelopeError, match="scheme"):
        validate(envelope(), link_resource="/campaigns/cmp_1")


def test_an_envelope_over_the_size_limit_is_refused() -> None:
    """`data` is opaque, so this is the only thing bounding what it can cost."""
    validate(envelope(data={"blob": "x" * (ENVELOPE_MAX_BYTES // 2)}))
    with pytest.raises(EnvelopeError, match="bytes"):
        validate(envelope(data={"blob": "x" * ENVELOPE_MAX_BYTES}))
