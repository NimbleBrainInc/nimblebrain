// Stage 1 deleted the conversation management tool surface
// (share/unshare/addParticipant/removeParticipant). Sharing returns in
// Stage 4 with policy-gated primitives — that PR adds the shape it
// actually needs. Keeping a `canManageConversation` helper + a
// `ManageConversationContext` interface around just because they
// _might_ be useful later violates CLAUDE.md's "don't design for
// hypothetical future requirements" rule, so this file is now empty.

export {};
