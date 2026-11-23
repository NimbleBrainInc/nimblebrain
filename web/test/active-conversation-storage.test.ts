import { beforeEach, describe, expect, it } from "bun:test";
import { getSavedConversation, setSavedConversation } from "../src/lib/active-conversation-storage";

describe("active-conversation-storage", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("returns null when nothing is saved", () => {
    expect(getSavedConversation()).toBeNull();
  });

  it("round-trips a conversation with its workspace", () => {
    setSavedConversation({ conversationId: "conv_abc123", workspaceId: "ws_a" });
    expect(getSavedConversation()).toEqual({ conversationId: "conv_abc123", workspaceId: "ws_a" });
  });

  it("clears the saved conversation when set to null (new/draft chat)", () => {
    setSavedConversation({ conversationId: "conv_abc123", workspaceId: "ws_a" });
    setSavedConversation(null);
    expect(getSavedConversation()).toBeNull();
  });

  it("reads a value without a workspace as nothing saved", () => {
    sessionStorage.setItem(
      "nb:activeConversation",
      JSON.stringify({ conversationId: "conv_abc123" }),
    );
    expect(getSavedConversation()).toBeNull();
  });
});
