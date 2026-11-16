"""The skills a host sees, read back and verified against their digests on both eras."""

import pytest
from skills_server import mcp

from nimblebrain_server_sdk.testing import Mode, served_skills


@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_the_server_publishes_its_skills(mode: Mode) -> None:
    skills = await served_skills(mcp, mode)  # lists, reads every file, checks each digest
    assert set(skills) == {"skill://notes/SKILL.md", "skill://glossary/SKILL.md"}
    notes = skills["skill://notes/SKILL.md"]
    assert notes["frontmatter"]["name"] == "notes"
    assert {r["uri"] for r in notes["resources"]} == {
        "skill://notes/SKILL.md",
        "skill://notes/references/style.md",
    }
