import { beforeEach, describe, expect, it } from "bun:test";
import {
  getSavedConversationId,
  setSavedConversationId,
} from "../src/lib/active-conversation-storage";

describe("active-conversation-storage", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("returns null when nothing is saved", () => {
    expect(getSavedConversationId()).toBeNull();
  });

  it("round-trips a conversation id", () => {
    setSavedConversationId("conv_abc123");
    expect(getSavedConversationId()).toBe("conv_abc123");
  });

  it("clears the saved id when set to null (new/draft chat)", () => {
    setSavedConversationId("conv_abc123");
    setSavedConversationId(null);
    expect(getSavedConversationId()).toBeNull();
  });
});
