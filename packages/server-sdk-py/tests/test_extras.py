"""The core works without either extra, and an extra's subpackage says when it is missing.

Each case runs in a fresh interpreter with the extra's dependencies blocked (a ``None`` entry
in ``sys.modules`` makes Python raise ``ImportError`` for that module), so it sees exactly what
an install without the extra sees. CI also runs the core against a real install with no extra
(``scripts/check_core_only.py``).
"""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap

import pytest

import nimblebrain_server_sdk.errors as errors

#: What each extra installs that the core does not, by the module a guard imports first.
DB_MODULES = ("pgbulkhead", "sqlalchemy", "asyncpg")
OBSERVABILITY_MODULES = ("prometheus_client", "structlog", "opentelemetry.sdk")


def run(block: tuple[str, ...], body: str) -> dict:
    """Run ``body`` in a fresh interpreter with ``block`` unimportable; return what it prints."""
    script = "import sys\n"
    script += "".join(f"sys.modules[{name!r}] = None\n" for name in block)
    script += textwrap.dedent(body)
    done = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, check=False
    )
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout.strip().splitlines()[-1])


def test_importing_the_core_imports_no_extra() -> None:
    out = run(
        (),
        """
        import json
        import nimblebrain_server_sdk, nimblebrain_server_sdk.errors
        extras = ("pgbulkhead", "sqlalchemy", "asyncpg", "prometheus_client", "structlog",
                  "opentelemetry.sdk", "nimblebrain_server_sdk.db",
                  "nimblebrain_server_sdk.observability")
        print(json.dumps(sorted(m for m in extras if m in sys.modules)))
        """,
    )
    assert out == []


@pytest.mark.parametrize(
    ("subpackage", "extra", "block"),
    [
        ("nimblebrain_server_sdk.db", "db", DB_MODULES),
        ("nimblebrain_server_sdk.db.session", "db", DB_MODULES),
        ("nimblebrain_server_sdk.observability", "observability", OBSERVABILITY_MODULES),
        ("nimblebrain_server_sdk.observability.metrics", "observability", OBSERVABILITY_MODULES),
    ],
)
def test_a_subpackage_without_its_extra_names_it(
    subpackage: str, extra: str, block: tuple[str, ...]
) -> None:
    out = run(
        block,
        f"""
        import importlib, json
        import nimblebrain_server_sdk, nimblebrain_server_sdk.errors
        try:
            importlib.import_module({subpackage!r})
        except ImportError as exc:
            print(json.dumps({{"type": type(exc).__name__, "is_import_error": True,
                              "message": str(exc)}}))
        else:
            print(json.dumps({{"type": None}}))
        """,
    )
    assert out["type"] == "MissingExtraError"
    assert out["is_import_error"]
    root = ".".join(subpackage.split(".")[:2])
    assert out["message"].startswith(f"{root} needs the [{extra}] extra")
    assert out["message"].endswith(f"pip install 'nimblebrain-server-sdk[{extra}]'")


def test_without_observability_a_surfaced_error_is_logged_not_counted() -> None:
    """The tool result is the one the contract pins; the record degrades to a stdlib log line."""
    out = run(
        OBSERVABILITY_MODULES,
        """
        import json, logging
        from nimblebrain_server_sdk.errors import (
            ServiceError, rate_limited_tool_error, to_tool_error)

        records = []
        class Keep(logging.Handler):
            def emit(self, record):
                records.append(record)
        logging.getLogger("nimblebrain_server_sdk.errors").addHandler(Keep())

        class Refusal:
            message = "The workspace is at capacity. Nothing was run."
            next_step = "Retry shortly."

        results = [
            to_tool_error(ServiceError.from_upstream(402, detail="operator-only text")),
            rate_limited_tool_error(Refusal()),
        ]
        print(json.dumps({
            "results": [[r.is_error, r.structured_content] for r in results],
            "records": [
                {"msg": r.getMessage(), "level": r.levelname,
                 **{k: getattr(r, k) for k in
                    ("code", "retryable", "upstream_status", "http_status", "detail")}}
                for r in records
            ],
            "observability_loaded": "nimblebrain_server_sdk.observability" in sys.modules,
        }))
        """,
    )
    assert out["results"] == [
        [
            True,
            {
                "error": {
                    "code": "quota_exhausted",
                    "retryable": False,
                    "message": "A third-party service rejected the request "
                    "(usage quota or credits exhausted).",
                    "upstream_status": 402,
                }
            },
        ],
        [
            True,
            {
                "error": {
                    "code": "rate_limited",
                    "retryable": True,
                    "message": "The workspace is at capacity. Nothing was run. Retry shortly.",
                }
            },
        ],
    ]
    assert out["records"] == [
        {
            "msg": "service_error",
            "level": "ERROR",
            "code": "quota_exhausted",
            "retryable": False,
            "upstream_status": 402,
            "http_status": 502,
            "detail": "operator-only text",
        },
        {
            "msg": "service_error",
            "level": "ERROR",
            "code": "rate_limited",
            "retryable": True,
            "upstream_status": None,
            "http_status": 429,
            "detail": None,
        },
    ]
    assert out["observability_loaded"] is False


def test_with_observability_the_core_records_through_it() -> None:
    from nimblebrain_server_sdk.observability import error_surface

    assert errors._recorder() is error_surface._record


def test_an_import_failure_other_than_a_missing_extra_is_not_swallowed() -> None:
    """Only ``MissingExtraError`` selects the log-only path; a broken install still raises."""
    out = run(
        (),
        """
        import json
        sys.modules["nimblebrain_server_sdk.observability.error_surface"] = None
        from nimblebrain_server_sdk.errors import ServiceError, ErrorCode, to_tool_error
        try:
            to_tool_error(ServiceError(ErrorCode.INTERNAL))
        except ImportError as exc:
            print(json.dumps(isinstance(exc, ImportError) and type(exc).__name__ != "MissingExtraError"))
        else:
            print(json.dumps(None))
        """,
    )
    assert out is True


@pytest.mark.parametrize(
    "failure",
    [
        "ImportError(\"cannot import name 'x' from partially initialized module\")",
        'ModuleNotFoundError("No module named \'a_dependency\'", name="a_dependency")',
    ],
)
def test_an_installed_dependency_that_fails_to_import_is_not_a_missing_extra(
    failure: str,
) -> None:
    """A guarded dependency that is installed but raises while loading propagates through
    recorder resolution; it does not select the log-only fallback."""
    out = run(
        (),
        f"""
        import importlib.abc, importlib.machinery, json

        class Broken(importlib.abc.MetaPathFinder, importlib.abc.Loader):
            def find_spec(self, name, path, target=None):
                if name == "prometheus_client":
                    return importlib.machinery.ModuleSpec(name, self)
                return None
            def create_module(self, spec):
                return None
            def exec_module(self, module):
                raise {failure}

        sys.modules.pop("prometheus_client", None)
        sys.meta_path.insert(0, Broken())
        from nimblebrain_server_sdk.errors import ServiceError, ErrorCode, to_tool_error
        try:
            to_tool_error(ServiceError(ErrorCode.INTERNAL))
        except ImportError as exc:
            print(json.dumps(type(exc).__name__))
        else:
            print(json.dumps(None))
        """,
    )
    assert out in ("ImportError", "ModuleNotFoundError")


def test_observability_re_exports_the_core_error_contract() -> None:
    import nimblebrain_server_sdk.observability as observability

    for name in (
        "CapacityRefusal",
        "ErrorCode",
        "ServiceError",
        "rate_limited_tool_error",
        "to_tool_error",
    ):
        assert getattr(observability, name) is getattr(errors, name), name


def test_db_re_exports_pgbulkheads_classes_as_the_same_objects() -> None:
    """An ``except`` in a server catches what pgbulkhead raises, so these are re-exports."""
    import pgbulkhead.admission
    import pgbulkhead.pool
    import pgbulkhead.role

    import nimblebrain_server_sdk.db as db

    for name in (
        "AdmittedSlot",
        "Overloaded",
        "PoolExhausted",
        "WorkspaceBusy",
        "WorkspaceLimiter",
    ):
        assert getattr(db, name) is getattr(pgbulkhead.admission, name), name
    for name in ("PoolConfigError", "PoolSettings", "create_pooled_engine"):
        assert getattr(db, name) is getattr(pgbulkhead.pool, name), name
    assert db.UnsafeRoleError is pgbulkhead.role.UnsafeRoleError
