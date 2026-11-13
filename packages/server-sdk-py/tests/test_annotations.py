"""The annotation constants say, in the MCP spec's hints, what a tool call can change."""

from nimblebrain_server_sdk import ADDS, CHANGES, READS


def test_a_read_is_read_only():
    assert READS.read_only_hint is True


def test_an_add_writes_without_destroying():
    assert ADDS.read_only_hint is False
    assert ADDS.destructive_hint is False


def test_a_change_is_a_destructive_write():
    assert CHANGES.read_only_hint is False
    assert CHANGES.destructive_hint is True
