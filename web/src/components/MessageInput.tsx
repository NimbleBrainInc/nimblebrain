import { ArrowUp, Paperclip } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StreamingState } from "../hooks/useChat";
import { FileAttachmentChips } from "./FileAttachmentChips";

const MAX_TEXTAREA_HEIGHT = 200;

interface MessageInputProps {
  onSend: (text: string, files?: File[]) => void;
  disabled: boolean;
  onNewConversation?: () => void;
  streamingState?: StreamingState;
}

export function MessageInput({
  onSend,
  disabled,
  onNewConversation,
  streamingState,
}: MessageInputProps) {
  const [text, setText] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: auto-resize only depends on text content changes
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [text]);

  useEffect(() => {
    if (!disabled) {
      textareaRef.current?.focus();
    }
  }, [disabled]);

  // Listen for nb:prompt events to pre-fill the input
  useEffect(() => {
    function handlePrompt(e: Event) {
      const prompt = (e as CustomEvent<{ prompt: string }>).detail?.prompt;
      if (prompt) {
        setText(prompt);
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
        });
      }
    }
    window.addEventListener("nb:prompt", handlePrompt);
    return () => window.removeEventListener("nb:prompt", handlePrompt);
  }, []);

  const addFiles = useCallback((newFiles: FileList | File[]) => {
    const arr = Array.from(newFiles);
    if (arr.length === 0) return;
    setAttachedFiles((prev) => [...prev, ...arr]);
  }, []);

  const removeFile = useCallback((index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if ((!trimmed && attachedFiles.length === 0) || disabled) return;

    // Handle /clear command
    if (trimmed === "/clear" && onNewConversation) {
      setText("");
      setAttachedFiles([]);
      onNewConversation();
      return;
    }

    onSend(trimmed, attachedFiles.length > 0 ? attachedFiles : undefined);
    setText("");
    setAttachedFiles([]);
  }, [text, attachedFiles, disabled, onSend, onNewConversation]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Clipboard paste handler for files
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        addFiles(files);
      }
    },
    [addFiles],
  );

  // Drag-and-drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      if (e.dataTransfer?.files) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        addFiles(e.target.files);
      }
      // Reset input so the same file can be re-selected
      e.target.value = "";
    },
    [addFiles],
  );

  const isActive = streamingState === "thinking" || streamingState === "working";
  const canSend = (text.trim() || attachedFiles.length > 0) && !disabled;

  return (
    <div className="py-3 shrink-0">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop container for file uploads */}
      <div
        className={`rounded-2xl border transition-all duration-200 bg-card ${
          isDragOver
            ? "border-primary shadow-lg shadow-primary/20"
            : isActive && !isFocused
              ? "input-breathing"
              : isFocused
                ? "border-ring shadow-lg shadow-ring/10"
                : "border-input shadow-lg shadow-border/20"
        } ${disabled ? "opacity-60" : ""}`}
        role="presentation"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Textarea */}
        <div className="px-4 pt-3">
          <textarea
            ref={textareaRef}
            className="w-full bg-transparent border-none outline-none resize-none text-sm font-sans leading-relaxed text-foreground placeholder:text-muted-foreground"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder={
              isDragOver
                ? "Drop files here..."
                : disabled
                  ? "Waiting for response..."
                  : "Ask anything..."
            }
            disabled={disabled}
            rows={1}
            style={{ minHeight: "28px", maxHeight: "200px" }}
          />
        </div>
        {/* File chips */}
        <FileAttachmentChips files={attachedFiles} onRemove={removeFile} />
        {/* Action buttons — attach left, send right */}
        <div className="flex items-center justify-between px-3 pb-3 pt-1">
          <div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileInputChange}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              type="button"
              aria-label="Attach files"
              className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-200 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Paperclip style={{ width: 16, height: 16 }} />
            </button>
          </div>
          <button
            onClick={handleSend}
            disabled={!canSend}
            type="button"
            aria-label="Send message"
            className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-200 ${
              canSend
                ? "bg-primary hover:bg-primary/90 text-primary-foreground"
                : "bg-muted text-muted-foreground cursor-not-allowed"
            }`}
          >
            <ArrowUp style={{ width: 18, height: 18 }} />
          </button>
        </div>
      </div>

      {/* Shortcut hints + state label */}
      <div className="flex items-center justify-center gap-3 mt-2 text-[10px] text-muted-foreground">
        {isActive && (
          <span className="text-processing font-mono font-medium">
            {streamingState === "working" ? "Working..." : "Thinking..."}
          </span>
        )}
        {onNewConversation && (
          <button
            type="button"
            onClick={onNewConversation}
            className="hover:text-foreground transition-colors"
          >
            <kbd className="px-1 py-0.5 font-mono bg-muted rounded border border-border text-[10px]">
              /clear
            </kbd>{" "}
            reset
          </button>
        )}
        <span>
          <kbd className="px-1 py-0.5 font-mono bg-muted rounded border border-border text-[10px]">
            ⌘K
          </kbd>{" "}
          close
        </span>
      </div>
    </div>
  );
}
