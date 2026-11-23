/**
 * The one constructor of a {@link ConversationScope}.
 *
 * A scope is built from a request context: the workspace the request was
 * admitted to (its URL's workspace after the membership gate, or the run's)
 * and its verified identity, which is the conversation owner. A tool's input
 * never names either half, so no value a caller typed can widen a scope.
 */

import type { ConversationScope } from "../conversation/store.ts";
import type { RequestContext } from "./request-context.ts";

/** Thrown when a conversation call is made with no workspace or no identity in scope. */
export class ConversationScopeMissingError extends Error {
  constructor(readonly missing: "workspace" | "identity") {
    super(
      missing === "workspace"
        ? "No workspace in scope: conversations are workspace-owned, so every call names one."
        : "No identity in scope: conversations are owner-private, so every call names an owner.",
    );
    this.name = "ConversationScopeMissingError";
  }
}

/** The scope of a request context. Throws when it carries no workspace or no identity. */
export function conversationScopeOf(
  ctx: Pick<RequestContext, "workspaceId"> & { identity: { id: string } | null | undefined },
): ConversationScope {
  if (!ctx.workspaceId) throw new ConversationScopeMissingError("workspace");
  if (!ctx.identity?.id) throw new ConversationScopeMissingError("identity");
  return Object.freeze({
    workspaceId: ctx.workspaceId,
    ownerId: ctx.identity.id,
  }) as ConversationScope;
}
