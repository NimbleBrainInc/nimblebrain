"""Pool settings: env-configurable defaults, and the rule that ties the pool to admission."""

from __future__ import annotations

import pytest

from nimblebrain_server_sdk.db import (
    CONNECTIONS_PER_CALL,
    PoolConfigError,
    PoolSettings,
    create_pooled_engine,
)


def test_defaults_hold_and_both_waits_sit_under_the_host_budget() -> None:
    settings = PoolSettings.from_env("SVC", environ={})
    assert settings == PoolSettings()
    assert CONNECTIONS_PER_CALL * settings.workspace_concurrency < settings.total
    assert settings.pool_timeout_seconds + settings.workspace_wait_seconds < 60


def test_from_env_reads_each_setting_under_the_prefix() -> None:
    settings = PoolSettings.from_env(
        "SVC",
        environ={
            "SVC_DB_POOL_SIZE": "6",
            "SVC_DB_POOL_MAX_OVERFLOW": " 3 ",
            "SVC_DB_POOL_TIMEOUT_SECONDS": "2.5",
            "SVC_WORKSPACE_CONCURRENCY": "2",
            "SVC_WORKSPACE_WAIT_SECONDS": "4",
            "OTHER_DB_POOL_SIZE": "99",
        },
    )
    assert settings == PoolSettings(
        pool_size=6,
        max_overflow=3,
        pool_timeout_seconds=2.5,
        workspace_concurrency=2,
        workspace_wait_seconds=4.0,
    )


def test_blank_value_takes_the_default() -> None:
    assert PoolSettings.from_env("SVC", environ={"SVC_DB_POOL_SIZE": "  "}).pool_size == 5


def test_fleet_defaults_are_conservative() -> None:
    assert PoolSettings() == PoolSettings(
        pool_size=5,
        max_overflow=5,
        pool_timeout_seconds=10.0,
        workspace_concurrency=2,
        workspace_wait_seconds=15.0,
    )


def test_a_server_passes_its_own_defaults_and_env_still_overrides_them() -> None:
    own = PoolSettings(pool_size=10, max_overflow=10, workspace_concurrency=4)
    assert PoolSettings.from_env("SVC", defaults=own, environ={}) == own
    overridden = PoolSettings.from_env(
        "SVC", defaults=own, environ={"SVC_WORKSPACE_CONCURRENCY": "3"}
    )
    assert (overridden.pool_size, overridden.workspace_concurrency) == (10, 3)


def test_concurrency_that_lets_one_workspace_hold_the_pool_is_refused() -> None:
    env = {"SVC_DB_POOL_SIZE": "5", "SVC_DB_POOL_MAX_OVERFLOW": "5"}
    with pytest.raises(PoolConfigError, match="SVC_"):
        PoolSettings.from_env("SVC", environ={**env, "SVC_WORKSPACE_CONCURRENCY": "5"})
    assert PoolSettings.from_env("SVC", environ={**env, "SVC_WORKSPACE_CONCURRENCY": "4"})
    # Settings that cannot hold are refused even when they are a server's own defaults.
    with pytest.raises(PoolConfigError):
        PoolSettings(pool_size=4, max_overflow=0, workspace_concurrency=2)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("SVC_DB_POOL_SIZE", "ten"),
        ("SVC_DB_POOL_SIZE", "0"),
        ("SVC_DB_POOL_MAX_OVERFLOW", "-1"),
        ("SVC_DB_POOL_TIMEOUT_SECONDS", "0"),
        ("SVC_DB_POOL_TIMEOUT_SECONDS", "soon"),
        ("SVC_WORKSPACE_CONCURRENCY", "0"),
        ("SVC_WORKSPACE_WAIT_SECONDS", "-3"),
    ],
)
def test_malformed_setting_is_refused(name: str, value: str) -> None:
    with pytest.raises(PoolConfigError):
        PoolSettings.from_env("SVC", environ={name: value})


async def test_engine_pool_is_sized_by_the_settings() -> None:
    settings = PoolSettings(
        pool_size=3, max_overflow=4, pool_timeout_seconds=1.5, workspace_concurrency=3
    )
    engine = create_pooled_engine("postgresql+asyncpg://u@127.0.0.1:1/db", settings)
    try:
        pool = engine.pool
        assert pool.size() == 3  # ty: ignore[unresolved-attribute]
        assert pool._max_overflow == 4  # ty: ignore[unresolved-attribute]
        assert pool._timeout == 1.5  # ty: ignore[unresolved-attribute]
        assert pool._pre_ping is True
    finally:
        await engine.dispose()
