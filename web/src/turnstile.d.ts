interface TurnstileRenderOptions {
  sitekey: string;
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
  theme?: "light" | "dark" | "auto";
  size?: "normal" | "compact" | "flexible";
  action?: string;
}

interface TurnstileAPI {
  render: (container: string | HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widgetId: string) => void;
  getResponse: (widgetId: string) => string | undefined;
  remove: (widgetId: string) => void;
  ready: (callback: () => void) => void;
  execute: (container: string | HTMLElement, options?: TurnstileRenderOptions) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileAPI;
  }
}

export {};
