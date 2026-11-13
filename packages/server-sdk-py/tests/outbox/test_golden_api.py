"""Golden: every name a consumer imports, and its shape.

``__all__``, the names consumers take from submodules, each callable's
parameters (name, kind, default), dataclass fields and the exception hierarchy.
A dropped name or a moved default breaks a consumer at import or at call time;
this fails first. ``api_shape`` reads the surface; see it for what is covered.

``tests/golden/api.json`` is frozen output with no regenerate path.
"""

from __future__ import annotations

import json
from pathlib import Path

from tests.outbox.api_shape import surface

GOLDEN = Path(__file__).parent / "golden" / "api.json"


def test_public_surface_matches_golden() -> None:
    assert json.loads(json.dumps(surface())) == json.loads(GOLDEN.read_text())
