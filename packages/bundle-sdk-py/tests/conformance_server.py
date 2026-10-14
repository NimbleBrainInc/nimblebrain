"""A skills server for the SEP-2640 conformance scenarios.

Serves the fixture skill directory plus one generated skill under a prefixed
path, over Streamable HTTP. `--server mcpserver` uses the `mcp` SDK's
`MCPServer` adapter instead of FastMCP. See the README for the command.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from nimblebrain_bundle_sdk.skills import (
    MCPServerSkillsExtension,
    SkillDefinition,
    SkillsExtension,
)

FIXTURES = Path(__file__).parent / "fixtures" / "skills"

GENERATED = SkillDefinition(
    "acme/billing/refunds",
    {
        "SKILL.md": "---\nname: refunds\ndescription: Process refund requests.\n---\n\n"
        "See `examples/email.md`.\n",
        "examples/email.md": "Dear customer,\n",
    },
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", choices=["fastmcp", "mcpserver"], default="fastmcp")
    parser.add_argument("--port", type=int, default=3001)
    args = parser.parse_args()
    skills = [FIXTURES / "pdf-processing", GENERATED]

    if args.server == "fastmcp":
        from fastmcp import FastMCP

        server = FastMCP("skills-conformance")
        server.add_extension(SkillsExtension(skills))
        server.run(transport="http", host="127.0.0.1", port=args.port, path="/mcp")
    else:
        from mcp.server.mcpserver import MCPServer

        mcp_server = MCPServer("skills-conformance", extensions=[MCPServerSkillsExtension(skills)])
        mcp_server.run(transport="streamable-http", host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
