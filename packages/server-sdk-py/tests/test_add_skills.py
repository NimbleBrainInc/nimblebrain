"""A server's skills are published through the Skills extension, and read back byte for byte."""

from __future__ import annotations

import pytest
from fastmcp import FastMCP

from nimblebrain_server_sdk import SkillDefinition, add_skills
from nimblebrain_server_sdk.testing import served_skills

SKILL_MD = (
    "---\nname: probe\ndescription: Does a thing.\n"
    "metadata:\n  nimblebrain:\n    loading-strategy: always\n---\n\nBody.\n"
)


def _probe() -> FastMCP:
    probe = FastMCP("probe")
    add_skills(
        probe,
        [SkillDefinition("probe", {"SKILL.md": SKILL_MD, "references/more.md": "More.\n"})],
    )
    return probe


@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_the_skill_lists_with_its_files_and_frontmatter(mode: str):
    entries = await served_skills(_probe(), mode)

    assert list(entries) == ["skill://probe/SKILL.md"]
    entry = entries["skill://probe/SKILL.md"]
    assert entry["frontmatter"]["metadata"] == {"nimblebrain": {"loading-strategy": "always"}}
    assert [r["uri"] for r in entry["resources"]] == [
        "skill://probe/SKILL.md",
        "skill://probe/references/more.md",
    ]


def test_a_name_that_differs_from_the_uri_fails_at_construction():
    with pytest.raises(ValueError, match="must equal the last segment"):
        add_skills(FastMCP("probe"), [SkillDefinition("other", {"SKILL.md": SKILL_MD})])


async def test_a_hand_registered_skill_resource_stops_the_server():
    probe = _probe()

    @probe.resource("skill://probe/SKILL.md", mime_type="text/markdown")
    def shadow() -> str:
        return SKILL_MD

    with pytest.raises(RuntimeError, match="another resource"):
        await served_skills(probe)
