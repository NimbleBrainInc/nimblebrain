import type { ConfigField, ConfirmationGate } from "../config/privilege.ts";
import { log } from "./log.ts";

/**
 * Pending prompt that the Ink App component renders and resolves.
 * The gate sets the prompt, Ink renders it, user types, Ink resolves it.
 */
export interface PendingPrompt {
  /** What to display to the user */
  label: string;
  /** Whether to mask the input */
  sensitive: boolean;
  /** Resolve the gate's promise with the user's input */
  resolve: (value: string) => void;
}

type PromptListener = (prompt: PendingPrompt | null) => void;

/**
 * Interactive TUI confirmation gate that works WITH Ink, not against it.
 *
 * Instead of fighting Ink for stdin, the gate publishes a PendingPrompt
 * that the App component renders as a UI element. The user types into
 * Ink's normal input loop, and submitting resolves the gate's promise.
 */
export class TuiConfirmationGate implements ConfirmationGate {
  readonly supportsInteraction = true;
  private listener: PromptListener | null = null;
  private connected = false;

  /** Subscribe to prompt requests (called by App component) */
  onPrompt(fn: PromptListener): () => void {
    this.listener = fn;
    this.connected = true;
    log.info("[gate] Ink prompt listener connected");
    return () => {
      this.listener = null;
      this.connected = false;
    };
  }

  async confirm(description: string, _details: Record<string, unknown>): Promise<boolean> {
    if (!this.connected) {
      // UI not connected — auto-approve (safe: engine will still execute)
      log.info(`[gate] No UI connected, auto-approving: ${description}`);
      return true;
    }
    log.info(`[gate] Prompting confirm: ${description}`);
    const answer = await this.requestInput(`${description} [y/N]`, false);
    log.info(`[gate] Confirm answer: ${JSON.stringify(answer)}`);
    return answer.toLowerCase().startsWith("y");
  }

  async promptConfigValue(field: ConfigField): Promise<string | null> {
    if (!this.connected) {
      log.info(`[gate] No UI connected, skipping prompt: ${field.title ?? field.key}`);
      return null;
    }
    const label = field.title ?? field.key;
    const desc = field.description ? ` — ${field.description}` : "";
    const req = field.required !== false ? " (required)" : "";
    log.info(`[gate] Prompting config value: ${label}`);
    const value = await this.requestInput(`${label}${desc}${req}`, field.sensitive ?? false);
    log.info(
      `[gate] Config value received: ${field.sensitive ? "(masked)" : value ? "yes" : "empty"}`,
    );
    return value || null;
  }

  private requestInput(label: string, sensitive: boolean): Promise<string> {
    return new Promise((resolve) => {
      if (!this.listener) {
        log.warn("[gate] requestInput called but listener is null!");
        resolve("");
        return;
      }
      this.listener({ label, sensitive, resolve });
    });
  }

  /** Called by App when prompt is resolved */
  clearPrompt(): void {
    // No-op — App manages its own state
  }
}
