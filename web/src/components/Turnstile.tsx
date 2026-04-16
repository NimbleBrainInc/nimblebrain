import { useCallback, useEffect, useRef } from "react";

const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;

/** Whether Turnstile is configured (site key is set). */
export const isTurnstileConfigured = !!SITE_KEY;

// Module-level state shared across all instances
let scriptLoaded = false;
let scriptLoading = false;
let currentWidgetId: string | null = null;

// Queued resolvers for concurrent callers while the script is loading
let pendingResolvers: (() => void)[] = [];

function loadScript(): Promise<void> {
  if (scriptLoaded) return Promise.resolve();
  if (scriptLoading) {
    return new Promise((resolve) => {
      pendingResolvers.push(resolve);
    });
  }

  scriptLoading = true;
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.onload = () => {
      scriptLoaded = true;
      scriptLoading = false;
      resolve();
      for (const r of pendingResolvers) r();
      pendingResolvers = [];
    };
    script.onerror = () => {
      scriptLoading = false;
      reject(new Error("Failed to load Turnstile script"));
    };
    document.head.appendChild(script);
  });
}

interface TurnstileProps {
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: () => void;
  theme?: "light" | "dark" | "auto";
}

export function Turnstile({ onVerify, onExpire, onError, theme = "auto" }: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  // Stable refs for callbacks so we don't re-render the widget when they change
  const onVerifyRef = useRef(onVerify);
  const onExpireRef = useRef(onExpire);
  const onErrorRef = useRef(onError);
  onVerifyRef.current = onVerify;
  onExpireRef.current = onExpire;
  onErrorRef.current = onError;

  const renderWidget = useCallback(() => {
    if (!containerRef.current || !window.turnstile) return;

    // Clean up any existing widget in this container
    if (widgetIdRef.current) {
      window.turnstile.remove(widgetIdRef.current);
      widgetIdRef.current = null;
      currentWidgetId = null;
    }

    const id = window.turnstile.render(containerRef.current, {
      sitekey: SITE_KEY,
      callback: (token: string) => onVerifyRef.current(token),
      "expired-callback": () => onExpireRef.current?.(),
      "error-callback": () => onErrorRef.current?.(),
      theme,
    });

    widgetIdRef.current = id;
    currentWidgetId = id;
  }, [theme]);

  useEffect(() => {
    if (!SITE_KEY) return;

    let destroyed = false;

    loadScript().then(() => {
      if (destroyed) return;
      renderWidget();
    });

    return () => {
      destroyed = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        if (currentWidgetId === widgetIdRef.current) {
          currentWidgetId = null;
        }
        widgetIdRef.current = null;
      }
    };
  }, [renderWidget]);

  if (!SITE_KEY) return null;

  return <div ref={containerRef} />;
}

/** Reset the Turnstile widget (call after failed login to get a new token). */
export function resetTurnstile(): void {
  if (currentWidgetId && window.turnstile) {
    window.turnstile.reset(currentWidgetId);
  }
}
