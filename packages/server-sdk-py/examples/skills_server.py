"""A server that publishes a skill: instructions an agent loads when its work matches."""

from pathlib import Path

from fastmcp import FastMCP

from nimblebrain_server_sdk import SkillDefinition, add_skills

mcp = FastMCP("notes")

# A directory holding SKILL.md and its reference files; the directory name is the skill's name.
NOTES_SKILL = Path(__file__).parent / "skills" / "notes"

# A skill whose files are built at startup instead of read from a directory.
glossary = SkillDefinition(
    "glossary",  # served at skill://glossary/SKILL.md
    {
        "SKILL.md": "---\nname: glossary\ndescription: The words this team uses.\n---\n\n"
        "A *note* is one fact. A *board* is a set of notes.\n",
    },
)

add_skills(mcp, [NOTES_SKILL, glossary])
