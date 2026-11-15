"""A tool that reads a workspace file through the host, and takes the text inline elsewhere."""

from fastmcp import Context, FastMCP
from fastmcp.tools import ToolResult
from mcp.types import TextResourceContents

from nimblebrain_server_sdk import READS, host
from nimblebrain_server_sdk.errors import ErrorCode, ServiceError, to_tool_error

mcp = FastMCP("summaries")


@mcp.tool(annotations=READS)
async def word_count(
    ctx: Context, file_uri: str | None = None, text: str | None = None
) -> dict[str, int] | ToolResult:
    """Count the words in a document. Pass `file_uri` for a workspace file, or `text` inline."""
    files = host(ctx)
    if file_uri and files.available:
        content = (await files.read(file_uri)).contents[0]
        if not isinstance(content, TextResourceContents):
            return to_tool_error(
                ServiceError(ErrorCode.BAD_INPUT, "That file is not text. Pass a text file.")
            )
        text = content.text
    elif file_uri:
        # No host-resources on this connection (the host does not offer it, or the connection
        # negotiated 2026-07-28): tell the agent how to call again, as an error it can read.
        return to_tool_error(
            ServiceError(
                ErrorCode.BAD_INPUT,
                "This connection cannot read workspace files. Pass the contents as `text`.",
            )
        )
    if text is None:
        return to_tool_error(ServiceError(ErrorCode.BAD_INPUT, "Pass `file_uri` or `text`."))
    return {"words": len(text.split())}
