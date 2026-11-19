import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { probeBootstrap } from "../api/client";
import type { BootstrapResponse } from "../types";
import { Logo } from "./Logo";

const RETRY_INTERVAL_MS = 2000;

/** Where a browser starts sign-in: the server redirects it on to the identity provider. */
export const SIGN_IN_PATH = "/v1/auth/authorize";

/**
 * A sign-in that comes back without a session inside this window is treated as
 * a loop (a session cookie that does not stick, say), so the screen stops and
 * offers the button instead of redirecting again.
 */
const REDIRECT_LOOP_WINDOW_MS = 30_000;
const REDIRECTED_AT_KEY = "nb-sign-in-redirected-at";

function redirectedRecently(now: number): boolean {
  try {
    const at = Number(sessionStorage.getItem(REDIRECTED_AT_KEY));
    return at > 0 && now - at < REDIRECT_LOOP_WINDOW_MS;
  } catch {
    return false;
  }
}

function noteRedirect(now: number): void {
  try {
    sessionStorage.setItem(REDIRECTED_AT_KEY, String(now));
  } catch {
    // Storage refused: the loop guard is off for this tab, sign-in still works.
  }
}

function clearRedirect(): void {
  try {
    sessionStorage.removeItem(REDIRECTED_AT_KEY);
  } catch {
    // Nothing to clear.
  }
}

export interface LoginProps {
  /**
   * Receives the bootstrap this screen already fetched. The parent must
   * authenticate from it rather than fetch again: a second bootstrap can fail
   * where this one succeeded (the session cookie cleared in between), and this
   * screen has stopped polling by then, so it would sit on "Connecting..."
   * forever.
   */
  onLogin: (data: BootstrapResponse) => void;
  /** Leaves the app for sign-in. Defaults to a full-page navigation; tests pass their own. */
  navigate?: (path: string) => void;
}

type Phase = "connecting" | "redirecting" | "signIn";

/**
 * The screen before a session exists. It is not a sign-in page: the identity
 * provider's page is. A server that refuses bootstrap (401) sends the browser
 * straight to sign-in. The button is shown only when going on would not help:
 * sign-in failed, or the last redirect came straight back without a session.
 *
 * A deployment without sign-in (the `dev` provider) never refuses bootstrap, so
 * it never redirects: the screen waits on "Connecting..." until the server
 * answers, then hands over.
 */
export function Login({ onLogin, navigate }: LoginProps) {
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [signingIn, setSigningIn] = useState(false);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigateRef = useRef(navigate ?? ((path: string) => window.location.assign(path)));

  useEffect(() => {
    let cancelled = false;

    // A failed sign-in comes back here with an error; show it and stop, or a
    // broken sign-in would loop through the provider forever.
    const params = new URLSearchParams(window.location.search);
    const failed = params.get("error") === "auth_failed";
    if (failed) {
      setError("Authentication failed. Please try again.");
      window.history.replaceState({}, "", window.location.pathname);
    }

    async function probe(): Promise<boolean> {
      const result = await probeBootstrap();
      if (cancelled) return true;
      if (result.kind === "signedIn") {
        clearRedirect();
        onLogin(result.data);
        return true;
      }
      if (result.kind === "signedOut") {
        const now = Date.now();
        if (failed || redirectedRecently(now)) {
          setPhase("signIn");
        } else {
          noteRedirect(now);
          setPhase("redirecting");
          navigateRef.current(SIGN_IN_PATH);
        }
        return true;
      }
      // Unavailable: the server is starting or failing, which says nothing
      // about the session. Keep polling.
      return false;
    }

    function poll() {
      if (cancelled) return;
      retryRef.current = setTimeout(async () => {
        if (cancelled) return;
        const done = await probe();
        if (!done && !cancelled) poll();
      }, RETRY_INTERVAL_MS);
    }

    probe().then((done) => {
      if (!done && !cancelled) poll();
    });

    return () => {
      cancelled = true;
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [onLogin]);

  function handleSignIn() {
    setSigningIn(true);
    noteRedirect(Date.now());
    navigateRef.current(SIGN_IN_PATH);
  }

  if (phase !== "signIn") {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="flex flex-col items-center gap-4">
          <Logo />
          <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>{phase === "redirecting" ? "Taking you to sign in…" : "Connecting..."}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center">
            <Logo />
          </CardTitle>
          <CardDescription>
            {error ? "Sign-in didn't finish." : "Sign in to continue."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Button onClick={handleSignIn} disabled={signingIn} className="w-full">
            {signingIn && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            {signingIn ? "Signing in…" : error ? "Try again" : "Sign In"}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
