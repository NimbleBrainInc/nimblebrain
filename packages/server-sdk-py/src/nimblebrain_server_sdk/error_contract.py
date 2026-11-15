"""Returning the error contract for an error a tool raises.

``to_tool_error`` is what a tool ``return``s. A tool that instead lets a ``ServiceError``
propagate reaches the caller as FastMCP's generic ``Error calling tool ...`` text, with no
code and nothing counted. :func:`add_error_contract` installs a middleware that turns the two
kinds of error the contract covers into the result the tool would have returned:

  * a :class:`~nimblebrain_server_sdk.errors.ServiceError`, ``[db]``'s ``AuthError`` among
    them, becomes ``to_tool_error(err)``;
  * a call refused for capacity (``[db]``'s ``Overloaded``, or anything else shaped like
    :class:`~nimblebrain_server_sdk.errors.CapacityRefusal`) becomes
    ``rate_limited_tool_error(err)``.

Every other exception propagates unchanged: an unclassified failure is a bug to see, not one
to dress as a contract error.
"""

from __future__ import annotations

from typing import Any

import mcp.types as mt
from fastmcp import FastMCP
from fastmcp.server.middleware import CallNext, Middleware, MiddlewareContext
from fastmcp.tools import ToolResult

from nimblebrain_server_sdk.errors import ServiceError, rate_limited_tool_error, to_tool_error

__all__ = ["ErrorContractMiddleware", "add_error_contract"]


def _contract_result(exc: BaseException) -> Any | None:
    """The tool result for ``exc`` when the contract covers it, else ``None``."""
    if isinstance(exc, ServiceError):
        return to_tool_error(exc)
    if isinstance(getattr(exc, "message", None), str) and isinstance(
        getattr(exc, "next_step", None), str
    ):
        return rate_limited_tool_error(exc)  # ty: ignore[invalid-argument-type]
    return None


class ErrorContractMiddleware(Middleware):
    """Returns the contract's tool error for a ``ServiceError`` or capacity refusal a tool raises."""

    async def on_call_tool(
        self,
        context: MiddlewareContext[mt.CallToolRequestParams],
        call_next: CallNext[mt.CallToolRequestParams, ToolResult],
    ) -> ToolResult:
        try:
            return await call_next(context)
        except Exception as exc:
            # FastMCP wraps what a tool raises in its own ToolError and chains the original.
            for candidate in (exc, exc.__cause__):
                if candidate is not None:
                    result = _contract_result(candidate)
                    if result is not None:
                        return result
            raise


def add_error_contract(mcp: FastMCP) -> None:
    """Make ``mcp`` return the error contract for a contract error a tool raises.

    Call it once, when the server is built. After it, a tool may let a ``ServiceError``
    (``[db]``'s ``AuthError`` is one) or a capacity refusal (``[db]``'s ``Overloaded``)
    propagate: the caller receives the same result as ``return to_tool_error(err)`` or
    ``return rate_limited_tool_error(err)``, recorded once. Other exceptions are untouched.
    It covers tool calls; a resource read has no in-band error result to return.
    """
    mcp.add_middleware(ErrorContractMiddleware())
