"""The outbox's four signals, on the shared ``[observability]`` registry.

They are declared through :mod:`nimblebrain_server_sdk.observability.metrics`, so they ride
the ``/metrics`` scrape ``instrument_app`` already serves and an adopter wires
nothing up.

**``name`` is the only label, and it is the adopter's to bound.** Event names
are server-defined and dotted (``domain.active``, ``reply.received``), which
makes them a closed set the server chooses at authoring time. Putting anything
derived from a request in one — a domain, a campaign id, a vendor's error
string — turns a handful of series into one per value, and Prometheus keeps
every one of them for as long as the retention window. If a value varies per
event, it belongs in ``data``, which no metric reads.
"""

from __future__ import annotations

from nimblebrain_server_sdk.observability.metrics import counter, gauge

EMITTED = counter(
    "notify_emitted_total",
    "Envelopes appended to the outbox, by event name.",
    labelnames=("name",),
)

READ = counter(
    "notify_read_total",
    "Outbox polls answered.",
)

CAPPED = counter(
    "notify_outbox_capped_total",
    "Rows dropped by the per-workspace row cap (an outbox nobody polls).",
)

#: Undelivered rows left after a poll — how far behind the reader is.
#:
#: Sampled once per poll and **not** labelled by workspace: identity is not a
#: metric label here (it lives on logs and spans), and a server
#: serves many workspaces from one process, so consecutive polls overwrite each
#: other and the instantaneous value is whichever workspace was polled last.
#: The signal is in the envelope, not the level — alert on
#: ``max_over_time(notify_outbox_depth[15m])``, which reads as "the deepest
#: outbox seen recently", and never on the raw gauge.
DEPTH = gauge(
    "notify_outbox_depth",
    "Undelivered rows remaining after a poll (a per-poll sample; aggregate with max_over_time).",
)

__all__ = ["CAPPED", "DEPTH", "EMITTED", "READ"]
