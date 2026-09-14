import { ArrowUp, Paperclip, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useComposerDraft } from "../hooks/useChat";
import { FileAttachmentChips } from "./FileAttachmentChips";
import { ModelPicker, type PickerModel } from "./ModelPicker";

const MAX_TEXTAREA_HEIGHT = 200;

/**
 * The right-hand cluster of the composer's action row: which model, and go.
 * They sit together because they answer one question between them — what is
 * about to happen when you press send.
 */
function ComposerActions({
  models,
  boundModel,
  defaultModel,
  pendingModel,
  onPendingModelChange,
  onNewConversationWithModel,
  busy,
  canSend,
  onSend,
  onStop,
}: {
  models?: PickerModel[];
  boundModel?: string;
  defaultModel?: string;
  pendingModel?: string;
  onPendingModelChange?: (model: string) => void;
  onNewConversationWithModel?: (model: string) => void;
  busy: boolean;
  canSend: boolean;
  onSend: () => void;
  onStop?: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {models && models.length > 0 && (
        <ModelPicker
          models={models}
          selected={pendingModel ?? defaultModel}
          bound={boundModel}
          onSelect={(id) => onPendingModelChange?.(id)}
          onNewConversation={onNewConversationWithModel}
          disabled={busy}
        />
      )}
      {busy && onStop ? (
        <button
          onClick={onStop}
          type="button"
          aria-label="Stop generating"
          className="shrink-0 flex items-center justify-center w-8 h-8 rounded-sm transition-all duration-200 cursor-pointer bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          <Square style={{ width: 14, height: 14 }} fill="currentColor" />
        </button>
      ) : (
        <button
          onClick={onSend}
          disabled={!canSend}
          type="button"
          aria-label="Send message"
          className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-sm transition-all duration-200 ${
            canSend
              ? "cursor-pointer bg-primary hover:bg-primary/90 text-primary-foreground"
              : "bg-muted text-muted-foreground cursor-not-allowed"
          }`}
        >
          <ArrowUp style={{ width: 18, height: 18 }} />
        </button>
      )}
    </div>
  );
}

interface MessageInputProps {
  onSend: (text: string, files?: File[], model?: string) => void;
  /** The conversation key the draft belongs to. The chat store holds the draft
   *  and clears it when it accepts a send, so a send it refuses loses nothing. */
  draftKey: string;
  /** Models this deployment offers. Empty hides the control entirely. */
  models?: PickerModel[];
  /** The binding, once the conversation exists. Absent before the first send. */
  boundModel?: string;
  /** What a message sent now would use, when nothing is bound yet. */
  defaultModel?: string;
  /** The pre-send choice. Owned above, so it can be reset per conversation. */
  pendingModel?: string;
  onPendingModelChange?: (model: string) => void;
  /** Start a fresh conversation on a chosen model, from the bound-state menu. */
  onNewConversationWithModel?: (model: string) => void;
  /** A turn is running. It gates sending, never composing: the draft stays
   *  editable so the next message can be written while the agent works. */
  busy: boolean;
  onNewConversation?: () => void;
  /** Open the keyboard-shortcuts dialog — the footer "?" affordance. */
  onShowShortcuts?: () => void;
  /** Stop the in-flight turn. When provided, the send button becomes a Stop
   *  button while a turn is streaming. */
  onStop?: () => void;
}

export function MessageInput({
  onSend,
  draftKey,
  models,
  boundModel,
  defaultModel,
  pendingModel,
  onPendingModelChange,
  onNewConversationWithModel,
  busy,
  onNewConversation,
  onShowShortcuts,
  onStop,
}: MessageInputProps) {
  const [draft, setDraft] = useComposerDraft(draftKey);
  const { text, files: attachedFiles } = draft;
  const [isFocused, setIsFocused] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  // Set when Enter is pressed while a turn runs, so the refusal is visible
  // rather than a keypress that silently does nothing. Clears with the turn.
  const [sendWaiting, setSendWaiting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: auto-resize only depends on text content changes
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [text]);

  // Put the cursor in the composer when a turn ends, unless focus is already
  // somewhere — including the composer itself, or an app iframe or field the
  // user moved to while waiting. A turn ending must not take focus away.
  useEffect(() => {
    if (busy) return;
    setSendWaiting(false);
    const active = document.activeElement;
    if (active && active !== document.body) return;
    textareaRef.current?.focus();
  }, [busy]);

  // Listen for nb:prompt events to pre-fill the input
  useEffect(() => {
    function handlePrompt(e: Event) {
      const prompt = (e as CustomEvent<{ prompt: string }>).detail?.prompt;
      if (prompt) {
        setDraft({ text: prompt });
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
        });
      }
    }
    window.addEventListener("nb:prompt", handlePrompt);
    return () => window.removeEventListener("nb:prompt", handlePrompt);
  }, [setDraft]);

  const addFiles = useCallback(
    (newFiles: FileList | File[]) => {
      const arr = Array.from(newFiles);
      if (arr.length === 0) return;
      setDraft({ files: [...attachedFiles, ...arr] });
    },
    [attachedFiles, setDraft],
  );

  const removeFile = useCallback(
    (index: number) => {
      setDraft({ files: attachedFiles.filter((_, i) => i !== index) });
    },
    [attachedFiles, setDraft],
  );

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && attachedFiles.length === 0) return;
    if (busy) {
      setSendWaiting(true);
      return;
    }

    // Handle /clear command
    if (trimmed === "/clear" && onNewConversation) {
      setDraft({ text: "", files: [] });
      onNewConversation();
      return;
    }

    onSend(trimmed, attachedFiles.length > 0 ? attachedFiles : undefined, pendingModel);
  }, [text, attachedFiles, pendingModel, busy, onSend, onNewConversation, setDraft]);

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

  const canSend = (text.trim().length > 0 || attachedFiles.length > 0) && !busy;

  return (
    <div className="py-3 shrink-0">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop container for file uploads */}
      <div
        // The raised card + blue ring follows focus alone. A running turn does
        // not dim the composer: writing the next message while the agent works
        // is expected. The "working" cue lives in the conversation ("Thinking…"
        // + the streaming reply) and the Stop button, not the input box.
        className={`rounded-lg border transition-all duration-200 ${
          isDragOver
            ? "bg-card border-primary shadow-lg shadow-primary/20"
            : isFocused
              ? "bg-card border-ring shadow-lg shadow-ring/10"
              : "bg-muted border-transparent"
        }`}
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
            onChange={(e) => setDraft({ text: e.target.value })}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder={
              isDragOver
                ? "Drop files here..."
                : busy
                  ? "Write your next message..."
                  : "Ask anything..."
            }
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
              type="button"
              aria-label="Attach files"
              className="shrink-0 flex items-center justify-center w-8 h-8 rounded-sm transition-all duration-200 text-muted-foreground cursor-pointer hover:text-foreground hover:bg-muted"
            >
              <Paperclip style={{ width: 16, height: 16 }} />
            </button>
          </div>
          <ComposerActions
            models={models}
            boundModel={boundModel}
            defaultModel={defaultModel}
            pendingModel={pendingModel}
            onPendingModelChange={onPendingModelChange}
            onNewConversationWithModel={onNewConversationWithModel}
            busy={busy}
            canSend={canSend}
            onSend={handleSend}
            onStop={onStop}
          />
        </div>
      </div>

      {/* Shortcut hints — status copy lives on the BlockTimeline / LiveCursor, not here. */}
      <div className="flex items-center justify-center gap-3 mt-2 text-3xs text-muted-foreground">
        {sendWaiting ? (
          <span role="status">Still replying — send when it finishes, or press Stop.</span>
        ) : (
          <>
            {onNewConversation && (
              <button
                type="button"
                onClick={onNewConversation}
                className="cursor-pointer hover:text-foreground transition-colors"
              >
                <kbd className="px-1 py-0.5 font-mono bg-muted rounded border border-border text-3xs">
                  /clear
                </kbd>{" "}
                reset
              </button>
            )}
            <span>
              <kbd className="px-1 py-0.5 font-mono bg-muted rounded border border-border text-3xs">
                ⌘K
              </kbd>{" "}
              close
            </span>
            {onShowShortcuts && (
              <button
                type="button"
                onClick={onShowShortcuts}
                className="cursor-pointer hover:text-foreground transition-colors"
              >
                <kbd className="px-1 py-0.5 font-mono bg-muted rounded border border-border text-3xs">
                  ?
                </kbd>{" "}
                shortcuts
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
