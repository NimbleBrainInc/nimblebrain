import { describe, expect, it } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { ChatProvider, useChatContext, useChatConfigContext } from "../src/context/ChatContext";
import type { AppContext } from "../src/types";

// --------------------------------------------------------------------------
// Minimal wrapper helper
// --------------------------------------------------------------------------

function wrapper({ children }: { children: ReactNode }) {
	return <ChatProvider>{children}</ChatProvider>;
}

function wrapperWithId(id: string) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return <ChatProvider initialConversationId={id}>{children}</ChatProvider>;
	};
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("ChatContext", () => {
	it("provides all useChat return values", () => {
		const { result } = renderHook(() => useChatContext(), { wrapper });

		expect(result.current.messages).toEqual([]);
		expect(result.current.isStreaming).toBe(false);
		expect(result.current.conversationId).toBeNull();
		expect(result.current.error).toBeNull();
		expect(typeof result.current.sendMessage).toBe("function");
		expect(typeof result.current.newConversation).toBe("function");
		expect(typeof result.current.loadConversation).toBe("function");
	});

	it("throws when used outside a ChatProvider", () => {
		expect(() => {
			renderHook(() => useChatContext());
		}).toThrow("useChatContext must be used within a ChatProvider");
	});

	it("passes initialConversationId to useChat", () => {
		const { result } = renderHook(() => useChatContext(), {
			wrapper: wrapperWithId("conv-123"),
		});

		expect(result.current.conversationId).toBe("conv-123");
	});

	it("sendMessage accepts optional appContext parameter", () => {
		const { result } = renderHook(() => useChatContext(), { wrapper });

		expect(result.current.sendMessage.length).toBeGreaterThanOrEqual(0);

		const ctx: AppContext = { appName: "my-app", serverName: "my-server" };
		const promise = result.current.sendMessage("hello", ctx);
		expect(promise).toBeInstanceOf(Promise);
	});

	it("newConversation resets state", async () => {
		const { result } = renderHook(() => useChatContext(), {
			wrapper: wrapperWithId("conv-456"),
		});

		expect(result.current.conversationId).toBe("conv-456");

		act(() => {
			result.current.newConversation();
		});

		expect(result.current.conversationId).toBeNull();
		expect(result.current.messages).toEqual([]);
		expect(result.current.error).toBeNull();
		expect(result.current.isStreaming).toBe(false);
	});
});

describe("ChatConfigContext", () => {
	it("provides config values", () => {
		const { result } = renderHook(() => useChatConfigContext(), { wrapper });

		expect(result.current.selectedModel).toBeNull();
		expect(typeof result.current.setSelectedModel).toBe("function");
		expect(result.current.configuredProviders).toEqual([]);
		expect(result.current.defaultModel).toBe("");
		expect(typeof result.current.refreshConfig).toBe("function");
		expect(result.current.participantMap).toBeInstanceOf(Map);
	});

	it("throws when used outside a ChatProvider", () => {
		expect(() => {
			renderHook(() => useChatConfigContext());
		}).toThrow("useChatConfigContext must be used within a ChatProvider");
	});

	it("accepts initialConfig from bootstrap", () => {
		function wrapperWithConfig({ children }: { children: ReactNode }) {
			return (
				<ChatProvider
					initialConfig={{
						configuredProviders: ["anthropic", "openai"],
						defaultModel: "claude-sonnet-4-5-20250929",
						preferences: { theme: "dark" },
					}}
				>
					{children}
				</ChatProvider>
			);
		}

		const { result } = renderHook(() => useChatConfigContext(), {
			wrapper: wrapperWithConfig,
		});

		expect(result.current.configuredProviders).toEqual(["anthropic", "openai"]);
		expect(result.current.defaultModel).toBe("claude-sonnet-4-5-20250929");
		expect(result.current.preferences).toEqual({ theme: "dark" });
	});

	it("config context value is stable when chat state changes", () => {
		// Verify that the config context object reference doesn't change
		// when only chat (streaming) state changes. This is the key property
		// that prevents shell re-renders during streaming.
		const refs: unknown[] = [];

		function wrapperBoth({ children }: { children: ReactNode }) {
			return <ChatProvider>{children}</ChatProvider>;
		}

		const { result } = renderHook(
			() => {
				const config = useChatConfigContext();
				const chat = useChatContext();
				return { config, chat };
			},
			{ wrapper: wrapperBoth },
		);

		refs.push(result.current.config);

		// Trigger a chat state change (newConversation resets messages)
		act(() => {
			result.current.chat.newConversation();
		});

		refs.push(result.current.config);

		// Config reference should be the same object — no unnecessary re-renders
		expect(refs[0]).toBe(refs[1]);
	});
});
