import { useCallback, useRef, useState } from "react";
import { callTool, streamChat, streamChatMultipart } from "../api/client";
import { captureEvent } from "../telemetry";
import type {
  AppContext,
  ChatRequest,
  ChatResult,
  ChatStreamEventMap,
  ChatStreamEventType,
  LlmDoneEvent,
  StreamErrorEvent,
  TextDeltaEvent,
  ToolDoneEvent,
  ToolStartEvent,
} from "../types";

/**
 * Trigger a browser download for a PDF resource served by an app.
 * Used when the agent calls export_pdf — fetches the compiled PDF
 * from the resource endpoint and triggers a save dialog.
 */
function triggerResourceDownload(serverName: string): void {
  const url = `${import.meta.env.VITE_API_BASE ?? ""}/v1/apps/${encodeURIComponent(serverName)}/resources/${encodeURIComponent(serverName)}/preview.pdf`;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "document.pdf";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => document.body.removeChild(anchor), 100);
}

/**
 * Streaming state machine:
 *
 *   null → thinking → streaming ↔ working → analyzing → streaming → null
 *                                                    ↘ working (next tool.start)
 *
 * `analyzing` fills the gap between the last tool.done (all tools finished)
 * and the next text.delta / tool.start, when the model is inferring on tool
 * results but the UI would otherwise look frozen. Any `tool.start` can
 * re-enter `working` from a non-terminal state.
 */
export type StreamingState = null | "thinking" | "streaming" | "working" | "analyzing";

/** Typed tool result shape forwarded through the bridge. */
export interface ToolResultForUI {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}

/** Tool call with UI state for streaming display. */
export interface ToolCallDisplay {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  ok?: boolean;
  ms?: number;
  resourceUri?: string;
  /** MCP `resource_link` blocks returned by the tool result, if any. */
  resourceLinks?: Array<{
    uri: string;
    name?: string;
    mimeType?: string;
    description?: string;
  }>;
  result?: ToolResultForUI;
  input?: Record<string, unknown>;
  appName?: string;
}

/** A block in the assistant message stream — text or tool call group, in temporal order. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool"; toolCalls: ToolCallDisplay[] };

/** Live iteration progress during streaming. */
export interface IterationProgress {
  n: number;
  inputTokens: number;
  outputTokens: number;
}

/** File metadata attached to a message. */
export interface MessageFileAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  extracted: boolean;
}

/** A chat message with ordered content blocks for display. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  blocks?: ContentBlock[];
  toolCalls?: ToolCallDisplay[];
  iteration?: IterationProgress;
  timestamp?: string;
  userId?: string;
  files?: MessageFileAttachment[];
  stopReason?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    model: string;
    llmMs: number;
  };
}

/** Conversation-level metadata for shared conversation support. */
export interface LoadedConversationMeta {
  ownerId?: string;
  visibility?: "private" | "shared";
  participants?: string[];
}

export interface UseChatReturn {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingState: StreamingState;
  conversationId: string | null;
  conversationMeta: LoadedConversationMeta | null;
  error: string | null;
  sendMessage: (
    text: string,
    appContext?: AppContext,
    model?: string,
    files?: File[],
  ) => Promise<void>;
  newConversation: () => void;
  loadConversation: (id: string) => Promise<void>;
  /** Inject a user message from another participant (remote stream). */
  injectRemoteUserMessage: (userId: string, displayName: string, content: string) => void;
  /** Process a streaming event from a remote participant's assistant response. */
  processRemoteStreamEvent: (type: string, data: unknown) => void;
}

/** Deep-copy blocks for immutable state updates. */
function cloneBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((b) => (b.type === "text" ? { ...b } : { ...b, toolCalls: [...b.toolCalls] }));
}

/** Derive full text from blocks. */
function textFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Wrap a plain string result into a ToolResultForUI. */
function wrapStringResult(text: string, isError = false): ToolResultForUI {
  return { content: [{ type: "text", text }], isError };
}

const updateTool =
  (evt: ToolDoneEvent) =>
  (tc: ToolCallDisplay): ToolCallDisplay =>
    tc.id === evt.id
      ? {
          ...tc,
          status: evt.ok ? ("done" as const) : ("error" as const),
          ok: evt.ok,
          ms: evt.ms,
          resourceUri: tc.resourceUri ?? evt.resourceUri,
          resourceLinks:
            evt.resourceLinks != null && evt.resourceLinks.length > 0
              ? evt.resourceLinks
              : tc.resourceLinks,
          result: evt.result != null ? (evt.result as ToolResultForUI) : tc.result,
        }
      : tc;

export function useChat(initialConversationId?: string, currentUserId?: string): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(
    initialConversationId ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [streamingState, setStreamingState] = useState<StreamingState>(null);
  const [conversationMeta, setConversationMeta] = useState<LoadedConversationMeta | null>(null);

  // Refs for building the current assistant message during streaming.
  const blocksRef = useRef<ContentBlock[]>([]);
  const toolCallsRef = useRef<ToolCallDisplay[]>([]);
  const iterationRef = useRef<IterationProgress | undefined>(undefined);

  /** Push current refs into the last assistant message. */
  function flushToMessage() {
    const currentBlocks = cloneBlocks(blocksRef.current);
    const currentText = textFromBlocks(blocksRef.current);
    const currentTools = [...toolCallsRef.current];
    const currentIteration = iterationRef.current ? { ...iterationRef.current } : undefined;
    setMessages((prev) => {
      const updated = [...prev];
      updated[updated.length - 1] = {
        role: "assistant",
        content: currentText,
        blocks: currentBlocks,
        toolCalls: currentTools,
        iteration: currentIteration,
      };
      return updated;
    });
  }

  const sendMessage = useCallback(
    async (text: string, appContext?: AppContext, model?: string, files?: File[]) => {
      if (isStreaming) return;

      setError(null);
      setIsStreaming(true);
      setStreamingState("thinking");
      blocksRef.current = [];
      toolCallsRef.current = [];
      iterationRef.current = undefined;

      // Add user message (with file previews if attached)
      const userFiles: MessageFileAttachment[] | undefined = files?.map((f) => ({
        id: `pending_${f.name}_${f.size}`,
        filename: f.name,
        mimeType: f.type || "application/octet-stream",
        size: f.size,
        extracted: false,
      }));
      const userMsg: ChatMessage = {
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
        ...(currentUserId ? { userId: currentUserId } : {}),
        ...(userFiles && userFiles.length > 0 ? { files: userFiles } : {}),
      };
      setMessages((prev) => [...prev, userMsg]);

      // Add placeholder assistant message
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: "",
        blocks: [],
        toolCalls: [],
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);

      // Enrich appContext with latest app state from the bridge (Synapse Feature 2)
      let enrichedContext = appContext;
      if (appContext) {
        const { getAppState } = await import("../bridge/bridge");
        const appStateEntry = getAppState(appContext.serverName);
        if (appStateEntry) {
          enrichedContext = { ...appContext, appState: appStateEntry };
        }
      }

      const req: ChatRequest = {
        message: text,
        ...(conversationId ? { conversationId } : {}),
        ...(enrichedContext ? { appContext: enrichedContext } : {}),
        ...(model ? { model } : {}),
      };

      try {
        const onEvent = <K extends ChatStreamEventType>(type: K, data: ChatStreamEventMap[K]) => {
          switch (type) {
            case "chat.start": {
              const evt = data as { conversationId: string };
              if (evt.conversationId) {
                setConversationId(evt.conversationId);
              }
              break;
            }
            case "text.delta": {
              const evt = data as TextDeltaEvent;
              setStreamingState((prev) => (prev !== "streaming" ? "streaming" : prev));
              // Append to last text block or create a new one
              const blocks = blocksRef.current;
              const lastBlock = blocks[blocks.length - 1];
              if (lastBlock && lastBlock.type === "text") {
                lastBlock.text += evt.text;
              } else {
                blocks.push({ type: "text", text: evt.text });
              }
              flushToMessage();
              break;
            }
            case "tool.start": {
              const evt = data as ToolStartEvent;
              setStreamingState("working");
              const separatorIdx = evt.name.indexOf("__");
              const newTool: ToolCallDisplay = {
                id: evt.id,
                name: evt.name,
                status: "running",
                resourceUri: evt.resourceUri,
                input: evt.input,
                appName: separatorIdx !== -1 ? evt.name.slice(0, separatorIdx) : undefined,
              };
              // Flat ref
              toolCallsRef.current = [...toolCallsRef.current, newTool];
              // Blocks — group consecutive tool calls
              const blocks = blocksRef.current;
              const lastBlock = blocks[blocks.length - 1];
              if (lastBlock && lastBlock.type === "tool") {
                lastBlock.toolCalls = [...lastBlock.toolCalls, newTool];
              } else {
                blocks.push({ type: "tool", toolCalls: [newTool] });
              }
              flushToMessage();
              break;
            }
            case "tool.done": {
              const evt = data as ToolDoneEvent;
              const updater = updateTool(evt);
              // Update flat ref
              toolCallsRef.current = toolCallsRef.current.map(updater);
              // Update in blocks
              for (const block of blocksRef.current) {
                if (block.type === "tool") {
                  block.toolCalls = block.toolCalls.map(updater);
                }
              }
              // Hold `working` while other parallel tools are still running;
              // only flip to `analyzing` when the last tool in the batch lands,
              // so the indicator reflects "model is inferring on results."
              const anyRunning = toolCallsRef.current.some((tc) => tc.status === "running");
              setStreamingState(anyRunning ? "working" : "analyzing");
              flushToMessage();

              // Auto-download: when agent calls export_pdf, trigger browser download
              if (evt.ok && evt.name.endsWith("__export_pdf")) {
                const serverName = evt.name.split("__")[0]!;
                triggerResourceDownload(serverName);
              }
              break;
            }
            case "llm.done": {
              const evt = data as LlmDoneEvent;
              iterationRef.current = {
                n: (iterationRef.current?.n ?? 0) + 1,
                inputTokens: (iterationRef.current?.inputTokens ?? 0) + evt.inputTokens,
                outputTokens: (iterationRef.current?.outputTokens ?? 0) + evt.outputTokens,
              };
              flushToMessage();
              break;
            }
            case "done": {
              const result = data as ChatResult;
              setStreamingState(null);
              setConversationId(result.conversationId);

              // Backfill tool results from done event
              if (result.toolCalls) {
                const outputMap = new Map(result.toolCalls.map((tc) => [tc.id, tc.output]));
                const backfill = (tc: ToolCallDisplay): ToolCallDisplay => {
                  if (tc.result != null) return tc;
                  const output = outputMap.get(tc.id);
                  return output != null ? { ...tc, result: wrapStringResult(output) } : tc;
                };
                for (const block of blocksRef.current) {
                  if (block.type === "tool") {
                    block.toolCalls = block.toolCalls.map(backfill);
                  }
                }
                toolCallsRef.current = toolCallsRef.current.map(backfill);
              }

              const finalBlocks = cloneBlocks(blocksRef.current);
              const finalTools =
                toolCallsRef.current.length > 0 ? [...toolCallsRef.current] : undefined;
              const usage = result.usage
                ? {
                    inputTokens: result.usage.inputTokens,
                    outputTokens: result.usage.outputTokens,
                    cacheReadTokens: result.usage.cacheReadTokens,
                    model: result.usage.model,
                    llmMs: result.usage.llmMs,
                  }
                : undefined;
              // Parse file attachments from done event metadata
              const resultFiles = (result as unknown as Record<string, unknown>).files as
                | MessageFileAttachment[]
                | undefined;

              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: result.response,
                  blocks: finalBlocks,
                  toolCalls: finalTools,
                  usage,
                  ...(result.stopReason && result.stopReason !== "complete"
                    ? { stopReason: result.stopReason }
                    : {}),
                  ...(resultFiles && resultFiles.length > 0 ? { files: resultFiles } : {}),
                };
                return updated;
              });
              break;
            }
            case "error": {
              const evt = data as StreamErrorEvent;
              setStreamingState(null);
              setError(evt.message);
              break;
            }
          }
        };
        if (files && files.length > 0) {
          await streamChatMultipart(req, files, onEvent);
        } else {
          await streamChat(req, onEvent);
        }
        captureEvent("web.chat_sent", {
          is_resume: !!conversationId,
          has_app_context: !!appContext,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "An unexpected error occurred";
        setError(msg);
      } finally {
        setIsStreaming(false);
        setStreamingState(null);
      }
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: sendMessage captures streaming/conversation state via refs
    [isStreaming, conversationId, currentUserId, flushToMessage],
  );

  const newConversation = useCallback(() => {
    setMessages([]);
    setConversationId(null);
    setConversationMeta(null);
    setError(null);
    setIsStreaming(false);
    setStreamingState(null);
    blocksRef.current = [];
    toolCallsRef.current = [];
    iterationRef.current = undefined;
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    setError(null);
    try {
      const res = await callTool("conversations", "get", { id });
      if (res.isError) {
        const errText = res.content
          ?.map((b) => b.text ?? "")
          .filter(Boolean)
          .join("\n");
        throw new Error(errText || "Failed to load conversation");
      }
      // Prefer structuredContent; fall back to parsing first text block.
      let raw: unknown = res.structuredContent;
      if (!raw && res.content?.[0]?.text) {
        try {
          raw = JSON.parse(res.content[0].text);
        } catch {
          raw = {};
        }
      }
      // The API already returns DisplayMessage[] in the exact shape ChatMessage
      // expects — one message per turn, blocks in iteration order, tool calls
      // hydrated with status+result. No reshaping needed here.
      const data = raw as {
        metadata: {
          id: string;
          ownerId?: string;
          visibility?: "private" | "shared";
          participants?: string[];
        };
        messages: ChatMessage[];
      };
      setConversationId(data.metadata.id);
      setConversationMeta({
        ownerId: data.metadata.ownerId,
        visibility: data.metadata.visibility,
        participants: data.metadata.participants,
      });
      setMessages(data.messages);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load conversation";
      setError(msg);
    }
  }, []);

  // --- Remote participant event injection ---

  const injectRemoteUserMessage = useCallback(
    (userId: string, _displayName: string, content: string) => {
      // Reset streaming refs for the incoming remote assistant response
      blocksRef.current = [];
      toolCallsRef.current = [];
      iterationRef.current = undefined;

      const userMsg: ChatMessage = {
        role: "user",
        content,
        timestamp: new Date().toISOString(),
        userId,
      };
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: "",
        blocks: [],
        toolCalls: [],
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);
      setStreamingState("thinking");
    },
    [],
  );

  const processRemoteStreamEvent = useCallback(
    (type: string, data: unknown) => {
      switch (type) {
        case "text.delta": {
          const evt = data as TextDeltaEvent;
          setStreamingState((prev) => (prev !== "streaming" ? "streaming" : prev));
          const blocks = blocksRef.current;
          const lastBlock = blocks[blocks.length - 1];
          if (lastBlock && lastBlock.type === "text") {
            lastBlock.text += evt.text;
          } else {
            blocks.push({ type: "text", text: evt.text });
          }
          flushToMessage();
          break;
        }
        case "tool.start": {
          const evt = data as ToolStartEvent;
          setStreamingState("working");
          const separatorIdx = evt.name.indexOf("__");
          const newTool: ToolCallDisplay = {
            id: evt.id,
            name: evt.name,
            status: "running",
            resourceUri: evt.resourceUri,
            input: evt.input,
            appName: separatorIdx !== -1 ? evt.name.slice(0, separatorIdx) : undefined,
          };
          toolCallsRef.current = [...toolCallsRef.current, newTool];
          const blocks = blocksRef.current;
          const lastBlock = blocks[blocks.length - 1];
          if (lastBlock && lastBlock.type === "tool") {
            lastBlock.toolCalls = [...lastBlock.toolCalls, newTool];
          } else {
            blocks.push({ type: "tool", toolCalls: [newTool] });
          }
          flushToMessage();
          break;
        }
        case "tool.done": {
          const evt = data as ToolDoneEvent;
          const updater = updateTool(evt);
          toolCallsRef.current = toolCallsRef.current.map(updater);
          for (const block of blocksRef.current) {
            if (block.type === "tool") {
              block.toolCalls = block.toolCalls.map(updater);
            }
          }
          const anyRunning = toolCallsRef.current.some((tc) => tc.status === "running");
          setStreamingState(anyRunning ? "working" : "analyzing");
          flushToMessage();
          break;
        }
        case "llm.done": {
          const evt = data as LlmDoneEvent;
          iterationRef.current = {
            n: (iterationRef.current?.n ?? 0) + 1,
            inputTokens: (iterationRef.current?.inputTokens ?? 0) + evt.inputTokens,
            outputTokens: (iterationRef.current?.outputTokens ?? 0) + evt.outputTokens,
          };
          flushToMessage();
          break;
        }
        case "done": {
          const result = data as ChatResult;
          setStreamingState(null);
          setIsStreaming(false);

          if (result.toolCalls) {
            const outputMap = new Map(result.toolCalls.map((tc) => [tc.id, tc.output]));
            const backfill = (tc: ToolCallDisplay): ToolCallDisplay => {
              if (tc.result != null) return tc;
              const output = outputMap.get(tc.id);
              return output != null ? { ...tc, result: wrapStringResult(output) } : tc;
            };
            for (const block of blocksRef.current) {
              if (block.type === "tool") {
                block.toolCalls = block.toolCalls.map(backfill);
              }
            }
            toolCallsRef.current = toolCallsRef.current.map(backfill);
          }

          const finalBlocks = cloneBlocks(blocksRef.current);
          const finalTools =
            toolCallsRef.current.length > 0 ? [...toolCallsRef.current] : undefined;
          const usage = result.usage
            ? {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                cacheReadTokens: result.usage.cacheReadTokens,
                model: result.usage.model,
                llmMs: result.usage.llmMs,
              }
            : undefined;

          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: result.response,
              blocks: finalBlocks,
              toolCalls: finalTools,
              usage,
              ...(result.stopReason && result.stopReason !== "complete"
                ? { stopReason: result.stopReason }
                : {}),
            };
            return updated;
          });
          break;
        }
      }
      // biome-ignore lint/correctness/useExhaustiveDependencies: SSE handler intentionally captures only flushToMessage
    },
    [flushToMessage],
  );

  return {
    messages,
    isStreaming,
    streamingState,
    conversationId,
    conversationMeta,
    error,
    sendMessage,
    newConversation,
    loadConversation,
    injectRemoteUserMessage,
    processRemoteStreamEvent,
  };
}
