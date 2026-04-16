import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CallbackEventSink } from "../adapters/callback-events.ts";
import type { Runtime } from "../runtime/runtime.ts";
import { Markdown } from "./markdown.tsx";
import type { PendingPrompt, TuiConfirmationGate } from "./tui-gate.ts";

interface AppProps {
  runtime: Runtime;
  eventSink: CallbackEventSink;
  initialConversationId?: string;
  confirmationGate?: TuiConfirmationGate;
}

interface ChatEntry {
  id: number;
  type: "user" | "assistant" | "error";
  text: string;
  skill?: string | null;
  tokens?: { input: number; output: number };
}

// --- Line editor with cursor position ---

interface LineState {
  text: string;
  cursor: number;
}

const EMPTY_LINE: LineState = { text: "", cursor: 0 };

function wordBoundaryLeft(text: string, pos: number): number {
  let i = pos;
  // Skip whitespace
  while (i > 0 && text[i - 1] === " ") i--;
  // Skip word chars
  while (i > 0 && text[i - 1] !== " ") i--;
  return i;
}

function wordBoundaryRight(text: string, pos: number): number {
  let i = pos;
  // Skip word chars
  while (i < text.length && text[i] !== " ") i++;
  // Skip whitespace
  while (i < text.length && text[i] === " ") i++;
  return i;
}

let nextId = 0;

export function App({ runtime, eventSink, initialConversationId, confirmationGate }: AppProps) {
  const { exit } = useApp();
  const lineState = useState<LineState>(EMPTY_LINE);
  const line = lineState[0];
  const rawSetLine = lineState[1];
  const lineRef = useRef<LineState>(EMPTY_LINE);
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [streamText, setStreamText] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const conversationId = useRef<string | undefined>(initialConversationId);

  // --- Confirmation/credential prompt state ---
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null);
  const [promptInput, setPromptInput] = useState("");

  useEffect(() => {
    if (!confirmationGate) return;
    const unsub = confirmationGate.onPrompt((prompt) => {
      setPendingPrompt(prompt);
      setPromptInput("");
    });
    return unsub;
  }, [confirmationGate]);

  // Keep ref in sync so useInput always sees current line
  const updateLine = useCallback((next: LineState | ((prev: LineState) => LineState)) => {
    rawSetLine((prev) => {
      const val = typeof next === "function" ? next(prev) : next;
      lineRef.current = val;
      return val;
    });
  }, []);

  // Input history (up/down arrow recall)
  const inputHistory = useRef<string[]>([]);
  const historyIndex = useRef(-1); // -1 = not browsing history
  const savedDraft = useRef(""); // text before entering history

  // Track active tool name for status indicator
  const [activeTool, setActiveTool] = useState<string | null>(null);

  // Subscribe to engine events for streaming text deltas + tool status
  useEffect(() => {
    const unsubscribe = eventSink.subscribe((event) => {
      if (event.type === "text.delta") {
        setStreamText((prev) => prev + (event.data.text as string));
      } else if (event.type === "tool.start") {
        setActiveTool(event.data.name as string);
      } else if (event.type === "tool.done") {
        setActiveTool(null);
      }
    });
    return unsubscribe;
  }, [eventSink]);

  const handleSubmit = useCallback(
    async (text: string) => {
      if (!text.trim() || isThinking) return;

      const message = text.trim();
      updateLine(EMPTY_LINE);

      // Push to input history (dedup consecutive)
      const hist = inputHistory.current;
      if (hist.length === 0 || hist[hist.length - 1] !== message) {
        hist.push(message);
      }
      historyIndex.current = -1;
      savedDraft.current = "";

      setChatHistory((h) => [...h, { id: nextId++, type: "user", text: message }]);
      setIsThinking(true);
      setStreamText("");

      try {
        const result = await runtime.chat({
          message,
          conversationId: conversationId.current,
        });

        conversationId.current = result.conversationId;

        setStreamText("");
        setChatHistory((h) => [
          ...h,
          {
            id: nextId++,
            type: "assistant",
            text: result.response,
            skill: result.skillName,
            tokens: { input: result.inputTokens, output: result.outputTokens },
          },
        ]);
      } catch (err) {
        setStreamText("");
        setChatHistory((h) => [
          ...h,
          {
            id: nextId++,
            type: "error",
            text: err instanceof Error ? err.message : String(err),
          },
        ]);
      } finally {
        setIsThinking(false);
      }
    },
    [runtime, isThinking, updateLine],
  );

  useInput((char, key) => {
    if (key.ctrl && char === "c") {
      if (pendingPrompt) {
        // Cancel the prompt
        pendingPrompt.resolve("");
        confirmationGate?.clearPrompt();
        setPendingPrompt(null);
        setPromptInput("");
        return;
      }
      if (lineRef.current.text.length > 0) {
        updateLine(EMPTY_LINE);
        historyIndex.current = -1;
      } else {
        exit();
      }
      return;
    }

    // --- Prompt mode: gate is waiting for user input ---
    if (pendingPrompt) {
      if (key.return) {
        const prompt = pendingPrompt;
        const value = promptInput;
        // Clear prompt state FIRST, then resolve the promise
        setPendingPrompt(null);
        setPromptInput("");
        // Resolve after state clear so Ink exits prompt mode cleanly
        setTimeout(() => prompt.resolve(value), 0);
        return;
      }
      if (key.backspace || key.delete) {
        setPromptInput((p) => p.slice(0, -1));
        return;
      }
      if (char && !key.ctrl && !key.meta && !key.escape && !key.tab) {
        setPromptInput((p) => p + char);
      }
      return;
    }

    if (isThinking) return;

    // --- Submit ---
    if (key.return) {
      handleSubmit(line.text);
      return;
    }

    // --- Backspace / Delete ---
    if (key.backspace || key.delete) {
      if (line.cursor === 0) return;
      if (key.meta) {
        // Option+Backspace: delete word backward
        const to = wordBoundaryLeft(line.text, line.cursor);
        updateLine({ text: line.text.slice(0, to) + line.text.slice(line.cursor), cursor: to });
      } else {
        updateLine({
          text: line.text.slice(0, line.cursor - 1) + line.text.slice(line.cursor),
          cursor: line.cursor - 1,
        });
      }
      return;
    }

    // --- Option/Meta + char (readline sequences) ---
    // Terminals send Option+Left as ESC b, Option+Right as ESC f,
    // Option+Backspace as ESC DEL, Option+D as ESC d (delete word forward).
    if (key.meta && !key.ctrl) {
      switch (char) {
        case "b": // Option+Left: word left
          updateLine((l) => ({ ...l, cursor: wordBoundaryLeft(l.text, l.cursor) }));
          return;
        case "f": // Option+Right: word right
          updateLine((l) => ({ ...l, cursor: wordBoundaryRight(l.text, l.cursor) }));
          return;
        case "d": // Option+D: delete word forward
          updateLine((l) => {
            const to = wordBoundaryRight(l.text, l.cursor);
            return { text: l.text.slice(0, l.cursor) + l.text.slice(to), cursor: l.cursor };
          });
          return;
      }
    }

    // --- Ctrl keybindings ---
    if (key.ctrl) {
      switch (char) {
        case "a": // Move to start
          updateLine((l) => ({ ...l, cursor: 0 }));
          return;
        case "e": // Move to end
          updateLine((l) => ({ ...l, cursor: l.text.length }));
          return;
        case "u": // Clear line before cursor
          updateLine((l) => ({ text: l.text.slice(l.cursor), cursor: 0 }));
          return;
        case "k": // Delete to end of line
          updateLine((l) => ({ text: l.text.slice(0, l.cursor), cursor: l.cursor }));
          return;
        case "w": // Delete word backward
          updateLine((l) => {
            const to = wordBoundaryLeft(l.text, l.cursor);
            return { text: l.text.slice(0, to) + l.text.slice(l.cursor), cursor: to };
          });
          return;
        case "l": // Clear screen (clear chat history)
          setChatHistory([]);
          return;
        case "d": // Forward delete (like fn+backspace)
          updateLine((l) => {
            if (l.cursor >= l.text.length) return l;
            return {
              text: l.text.slice(0, l.cursor) + l.text.slice(l.cursor + 1),
              cursor: l.cursor,
            };
          });
          return;
      }
    }

    // --- Arrow keys ---
    if (key.leftArrow) {
      if (key.meta) {
        // Option+Left: move word left
        updateLine((l) => ({ ...l, cursor: wordBoundaryLeft(l.text, l.cursor) }));
      } else {
        updateLine((l) => ({ ...l, cursor: Math.max(0, l.cursor - 1) }));
      }
      return;
    }

    if (key.rightArrow) {
      if (key.meta) {
        // Option+Right: move word right
        updateLine((l) => ({ ...l, cursor: wordBoundaryRight(l.text, l.cursor) }));
      } else {
        updateLine((l) => ({ ...l, cursor: Math.min(l.text.length, l.cursor + 1) }));
      }
      return;
    }

    // --- Input history ---
    if (key.upArrow) {
      const hist = inputHistory.current;
      if (hist.length === 0) return;
      if (historyIndex.current === -1) {
        // Entering history — save current draft
        savedDraft.current = line.text;
        historyIndex.current = hist.length - 1;
      } else if (historyIndex.current > 0) {
        historyIndex.current--;
      } else {
        return; // Already at oldest
      }
      const entry = hist[historyIndex.current]!;
      updateLine({ text: entry, cursor: entry.length });
      return;
    }

    if (key.downArrow) {
      const hist = inputHistory.current;
      if (historyIndex.current === -1) return; // Not in history
      if (historyIndex.current < hist.length - 1) {
        historyIndex.current++;
        const entry = hist[historyIndex.current]!;
        updateLine({ text: entry, cursor: entry.length });
      } else {
        // Back to draft
        historyIndex.current = -1;
        const draft = savedDraft.current;
        updateLine({ text: draft, cursor: draft.length });
      }
      return;
    }

    // --- Ignore other control sequences ---
    if (key.escape || key.tab) return;

    // --- Character input ---
    if (char) {
      updateLine((l) => ({
        text: l.text.slice(0, l.cursor) + char + l.text.slice(l.cursor),
        cursor: l.cursor + char.length,
      }));
    }
  });

  // Render input line with cursor
  const beforeCursor = line.text.slice(0, line.cursor);
  const cursorChar = line.text[line.cursor] ?? " ";
  const afterCursor = line.text.slice(line.cursor + 1);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          nimblebrain
        </Text>
        {conversationId.current && <Text dimColor> [{conversationId.current}]</Text>}
        <Text dimColor> — type a message, ctrl+c to quit</Text>
      </Box>

      {chatHistory.map((entry) => (
        <Box key={entry.id} flexDirection="column" marginBottom={1}>
          {entry.type === "user" && (
            <Box>
              <Text bold color="green">
                {"❯ "}
              </Text>
              <Text>{entry.text}</Text>
            </Box>
          )}
          {entry.type === "assistant" && (
            <Box flexDirection="column">
              <Markdown>{entry.text}</Markdown>
              <Text dimColor>
                {[
                  entry.skill && `skill:${entry.skill}`,
                  entry.tokens && `${entry.tokens.input + entry.tokens.output} tokens`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </Box>
          )}
          {entry.type === "error" && <Text color="red">Error: {entry.text}</Text>}
        </Box>
      ))}

      {isThinking && (
        <Box flexDirection="column" marginBottom={1}>
          {streamText ? <Markdown>{streamText}</Markdown> : <Text dimColor>thinking...</Text>}
          {activeTool && !pendingPrompt && <Text dimColor> ⟳ running {activeTool}...</Text>}
        </Box>
      )}

      {pendingPrompt && (
        <Box
          flexDirection="column"
          marginBottom={1}
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
        >
          <Text bold color="yellow">
            {pendingPrompt.label}
          </Text>
          <Box>
            <Text color="yellow">{"› "}</Text>
            <Text>{pendingPrompt.sensitive ? "•".repeat(promptInput.length) : promptInput}</Text>
            <Text inverse> </Text>
          </Box>
        </Box>
      )}

      {!isThinking && !pendingPrompt && (
        <Box>
          <Text bold color="green">
            {"❯ "}
          </Text>
          <Text>{beforeCursor}</Text>
          <Text inverse>{cursorChar}</Text>
          <Text>{afterCursor}</Text>
        </Box>
      )}
    </Box>
  );
}
