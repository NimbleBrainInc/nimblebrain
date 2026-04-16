import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { tryBootstrap } from "../api/client";
import { Logo } from "./Logo";

const RETRY_INTERVAL_MS = 2000;

export interface LoginProps {
  onLogin: () => void;
}

export function Login({ onLogin }: LoginProps) {
  const [error, setError] = useState<string | null>(null);
  const [serverReachable, setServerReachable] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Check for auth error from OIDC callback redirect
    const params = new URLSearchParams(window.location.search);
    if (params.get("error") === "auth_failed") {
      setError("Authentication failed. Please try again.");
      window.history.replaceState({}, "", window.location.pathname);
    }

    // Poll until the server is reachable. If bootstrap succeeds (e.g. after
    // an OIDC redirect that set a session cookie), notify the parent.
    async function probe(): Promise<boolean> {
      const data = await tryBootstrap();
      if (cancelled) return true;
      if (data) {
        // Already authenticated (e.g. cookie from OIDC callback)
        onLogin();
        return true;
      }
      // tryBootstrap returns null for both 401 and network errors.
      // Try a lightweight fetch to distinguish "server down" from "not authed".
      try {
        const res = await fetch("/v1/health");
        if (cancelled) return true;
        if (res.ok) {
          setServerReachable(true);
          return true;
        }
      } catch {
        // Server not reachable — keep polling
      }
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
    window.location.href = "/v1/auth/authorize";
  }

  // Waiting for the backend to come up
  if (!serverReachable) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="flex flex-col items-center gap-4">
          <Logo variant="full" height={28} />
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Connecting...</span>
          </div>
        </div>
      </div>
    );
  }

  // Server is up, user needs to sign in
  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center">
            <Logo variant="full" height={28} />
          </CardTitle>
          <CardDescription>Sign in to continue.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Button onClick={handleSignIn} disabled={signingIn} className="w-full">
            {signingIn && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            {signingIn ? "Signing in…" : "Sign In"}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
