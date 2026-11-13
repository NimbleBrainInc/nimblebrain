"""The envelope a server writes, and the rules it has to satisfy.

The shape is the MCP Triggers-and-Events sketch's ``EventOccurrence`` —
``eventId``, ``name``, ``timestamp``, ``data``, an optional per-event ``cursor``
and an optional ``_meta`` — with everything this host renders and routes on
living under the reverse-DNS key :data:`NOTIFICATION_META_KEY`. A server that
emits a bare ``EventOccurrence`` with no ``_meta`` is still emitting a
notification; the block is additive.

**Validation raises; it does not repair.** The host re-derives every envelope
from ``unknown`` and quietly drops or shortens what it cannot use, because the
bytes reaching it were written by a server it does not trust. Here the writer
*is* the server, the strings are composed by its own code, and a title that is
one character over the host's limit is a bug in that code — so it fails at the
emit, in the adopter's own tests, rather than shipping and being trimmed by
something two hops away. The limits below are the host's limits exactly, which
is what makes "accepted here" mean "rendered whole there".

Because :func:`nimblebrain_server_sdk.outbox.core.emit` appends inside the caller's
transaction, a raise rolls that transaction back. Compose bounded text: the
caps are exported so an adopter with genuinely unbounded upstream text can trim
it deliberately, at the point where it knows what is safe to lose.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any

#: The reverse-DNS ``_meta`` key carrying everything the host renders and
#: routes on. Adopters never write it by hand — pass the presentation fields to
#: :func:`nimblebrain_server_sdk.outbox.core.emit` and it builds the block.
NOTIFICATION_META_KEY = "ai.nimblebrain/notification"

#: The urgency vocabulary, least to most urgent. Advisory: a route may match on
#: it and an inbox may sort by it, and the workspace's per-source ceiling clamps
#: it. Nothing treats it as authority.
LEVELS = ("info", "attention", "urgent")

#: What an envelope with no ``level`` means.
DEFAULT_LEVEL = "info"

# The host's own limits. A value accepted here and trimmed there would mean the
# text an operator reads is not the text the server wrote, so the runtime beside
# this package checks every limit in this module against its own
# (`test/unit/notifications/server-sdk-parity.test.ts`) and fails on a mismatch.
TITLE_MAX = 200
BODY_MAX = 2000
SUBJECT_MAX = 200
LINK_MAX = 2048
NAME_MAX = 200
EVENT_ID_MAX = 200

#: Longest serialized envelope, in bytes of UTF-8 JSON — the host's inbox bound.
#: ``data`` is opaque here, so this is the only thing stopping an opaque payload
#: from deciding how large a workspace's inbox gets.
ENVELOPE_MAX_BYTES = 64 * 1024

#: URI schemes a ``link.resource`` may never carry. Each is a scheme a renderer
#: can be talked into executing, or into reading local state from, and the link
#: is the one envelope field aimed at a click.
FORBIDDEN_LINK_SCHEMES = frozenset({"javascript", "data", "vbscript", "file", "blob"})

_URI_WITH_SCHEME = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.\-]*):")


class EnvelopeError(ValueError):
    """An envelope this outbox will not store. The message names the field."""


@dataclass(frozen=True, slots=True)
class ValidatedEnvelope:
    """One envelope, checked and split into the columns it is stored as."""

    event_id: str
    name: str
    timestamp: datetime
    data: dict[str, Any]
    #: The whole ``_meta`` block, not just this host's key. Unknown reverse-DNS
    #: blocks are carried through unread, the way the host carries them.
    meta: dict[str, Any]


def validate(
    envelope: dict[str, Any],
    *,
    title: str | None = None,
    level: str | None = None,
    subject: str | None = None,
    body: str | None = None,
    link_resource: str | None = None,
) -> ValidatedEnvelope:
    """Check one envelope, building its presentation block from the keywords.

    The keywords are the convenience form: pass ``title=`` / ``level=`` and the
    ``_meta[NOTIFICATION_META_KEY]`` block is assembled here, so an adopter
    never types the reverse-DNS key. Passing both a keyword and a hand-written
    block is refused rather than merged — two sources for one field is how they
    end up disagreeing.
    """
    if not isinstance(envelope, dict):
        raise EnvelopeError("envelope must be a JSON object")

    event_id = _required_text(envelope.get("eventId"), "eventId", EVENT_ID_MAX)
    name = _required_text(envelope.get("name"), "name", NAME_MAX)
    timestamp = _timestamp(envelope.get("timestamp"))

    data = envelope.get("data")
    if not isinstance(data, dict):
        raise EnvelopeError("data is required and must be a JSON object")

    meta = _meta_block(
        envelope.get("_meta"),
        title=title,
        level=level,
        subject=subject,
        body=body,
        link_resource=link_resource,
        name=name,
    )

    unknown = set(envelope) - {"eventId", "name", "timestamp", "data", "cursor", "_meta"}
    if unknown:
        raise EnvelopeError(
            f"envelope carries fields that are not part of the contract: {sorted(unknown)}. "
            "Structured payload belongs in `data`; presentation belongs in the _meta block."
        )

    _check_size(event_id, name, timestamp, data, meta)
    return ValidatedEnvelope(
        event_id=event_id, name=name, timestamp=timestamp, data=data, meta=meta
    )


def _meta_block(
    raw: object,
    *,
    title: str | None,
    level: str | None,
    subject: str | None,
    body: str | None,
    link_resource: str | None,
    name: str,
) -> dict[str, Any]:
    """Build (or check) the whole ``_meta`` block for one envelope."""
    from_keywords = any(value is not None for value in (title, level, subject, body, link_resource))

    if raw is None:
        meta: dict[str, Any] = {}
    elif isinstance(raw, dict):
        meta = dict(raw)
    else:
        raise EnvelopeError("_meta must be a JSON object")

    written = meta.get(NOTIFICATION_META_KEY)
    if from_keywords and written is not None:
        raise EnvelopeError(
            f"pass the presentation fields as keywords or write {NOTIFICATION_META_KEY!r} "
            "by hand, not both"
        )

    if from_keywords:
        presentation: dict[str, Any] = {
            "level": level if level is not None else DEFAULT_LEVEL,
            "title": title if title is not None else name,
        }
        if subject is not None:
            presentation["subject"] = subject
        if body is not None:
            presentation["body"] = body
        if link_resource is not None:
            presentation["link"] = {"resource": link_resource}
        meta[NOTIFICATION_META_KEY] = presentation
    elif written is None:
        return meta

    _check_presentation(meta[NOTIFICATION_META_KEY])
    return meta


def _check_presentation(block: object) -> None:
    """Check this host's ``_meta`` block. Unknown keys inside it are left alone."""
    if not isinstance(block, dict):
        raise EnvelopeError(f"{NOTIFICATION_META_KEY} must be a JSON object")

    level = block.get("level", DEFAULT_LEVEL)
    if level not in LEVELS:
        raise EnvelopeError(f"level must be one of {list(LEVELS)}, not {level!r}")

    _plain_text(block.get("title"), "title", TITLE_MAX)
    _plain_text(block.get("subject"), "subject", SUBJECT_MAX)
    _plain_text(block.get("body"), "body", BODY_MAX)

    link = block.get("link")
    if link is None:
        return
    if not isinstance(link, dict):
        raise EnvelopeError("link must be a JSON object")
    resource = link.get("resource")
    if resource is None:
        return
    _check_link(resource)


def _check_link(resource: object) -> None:
    if not isinstance(resource, str) or not resource:
        raise EnvelopeError("link.resource must be a non-empty string")
    if len(resource) > LINK_MAX:
        raise EnvelopeError(f"link.resource is longer than {LINK_MAX} characters")
    if _has_control_chars(resource):
        raise EnvelopeError("link.resource carries control characters")
    match = _URI_WITH_SCHEME.match(resource)
    if match is None:
        raise EnvelopeError("link.resource must be a URI carrying a scheme")
    if match.group(1).lower() in FORBIDDEN_LINK_SCHEMES:
        raise EnvelopeError(f"link.resource may not use the {match.group(1)!r} scheme")


def _required_text(value: object, field: str, maximum: int) -> str:
    if not isinstance(value, str) or not value:
        raise EnvelopeError(f"{field} is required and must be a non-empty string")
    if len(value) > maximum:
        raise EnvelopeError(f"{field} is longer than {maximum} characters")
    if _has_control_chars(value):
        raise EnvelopeError(f"{field} carries control characters")
    return value


def _plain_text(value: object, field: str, maximum: int) -> None:
    """Check one optional plain-text presentation field.

    Control characters are refused rather than stripped in all three fields,
    including ``body``: every surface that shows them — an inbox row, a Slack
    message rendered from a route template, a log line — shows them as one line
    of plain text, so a newline or an escape sequence in them is never content.
    """
    if value is None:
        return
    if not isinstance(value, str):
        raise EnvelopeError(f"{field} must be a string")
    if len(value) > maximum:
        raise EnvelopeError(f"{field} is longer than {maximum} characters")
    if _has_control_chars(value):
        raise EnvelopeError(f"{field} carries control characters; it renders as one line")


def _has_control_chars(value: str) -> bool:
    return any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value)


def _timestamp(value: object) -> datetime:
    """Read ``timestamp`` as an aware datetime.

    A ``datetime`` is accepted so a caller that already has one does not
    round-trip it through a string. A naive one is refused: a wall-clock time
    with no offset says when something happened only if you already know where,
    and the row it lands in is a ``timestamptz``.
    """
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError as exc:
            raise EnvelopeError("timestamp must be an ISO 8601 datetime") from exc
    else:
        raise EnvelopeError("timestamp is required and must be an ISO 8601 datetime")

    if parsed.tzinfo is None or parsed.tzinfo.utcoffset(parsed) is None:
        raise EnvelopeError("timestamp must carry a UTC offset")
    return parsed


def _check_size(
    event_id: str, name: str, timestamp: datetime, data: dict[str, Any], meta: dict[str, Any]
) -> None:
    """Refuse an envelope larger than the host's inbox will admit.

    Serializing is also the only honest check that ``data`` is JSON: a dict of
    arbitrary Python objects is not, and the failure belongs at the emit rather
    than at the ``json.dumps`` inside the poll that answers three hours later.
    """
    body: dict[str, Any] = {
        "eventId": event_id,
        "name": name,
        "timestamp": timestamp.isoformat(),
        "data": data,
    }
    if meta:
        body["_meta"] = meta
    try:
        encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise EnvelopeError(f"envelope is not JSON-serializable: {exc}") from exc
    if len(encoded) > ENVELOPE_MAX_BYTES:
        raise EnvelopeError(
            f"envelope serializes to {len(encoded)} bytes, over the {ENVELOPE_MAX_BYTES}-byte limit"
        )
