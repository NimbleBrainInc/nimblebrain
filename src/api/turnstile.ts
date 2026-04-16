const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResponse {
  success: boolean;
  "error-codes": string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
}

let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;

/** Reset consecutive failure counter (for testing). */
export function resetTurnstileState(): void {
  consecutiveFailures = 0;
}

/**
 * Validate a Turnstile token with Cloudflare's siteverify API.
 * Returns null if validation passes or is not configured (dev mode).
 * Returns an error message string if validation fails.
 */
export async function verifyTurnstileToken(
  token: string | undefined,
  remoteIp?: string,
): Promise<string | null> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return null; // Dev mode — Turnstile not configured

  if (!token) return "Turnstile token is required";

  // Fail-closed after consecutive API failures
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return "Bot verification temporarily unavailable. Please try again later.";
  }

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret,
        response: token,
        ...(remoteIp && { remoteip: remoteIp }),
      }),
    });

    if (!res.ok) {
      consecutiveFailures++;
      console.error(
        `[nimblebrain] Turnstile siteverify HTTP error: ${res.status} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} consecutive failures)`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(
          "[nimblebrain] Turnstile fail-closed: rejecting requests until siteverify recovers",
        );
      }
      return null; // Still fail open for THIS request (under threshold)
    }

    const data = (await res.json()) as SiteverifyResponse;

    if (data.success) {
      consecutiveFailures = 0; // Reset on success
      return null;
    }

    // Verification failed (not an API error — don't count toward consecutive failures)
    consecutiveFailures = 0; // API is working, just rejected the token
    const codes = data["error-codes"] ?? [];
    console.error(`[nimblebrain] Turnstile verification failed: ${codes.join(", ")}`);

    if (codes.includes("timeout-or-duplicate")) {
      return "Turnstile token expired or already used. Please try again.";
    }

    return "Turnstile verification failed";
  } catch (err) {
    consecutiveFailures++;
    console.error(
      `[nimblebrain] Turnstile siteverify fetch error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`,
      err,
    );
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(
        "[nimblebrain] Turnstile fail-closed: rejecting requests until siteverify recovers",
      );
    }
    return null; // Still fail open for THIS request
  }
}

/** Whether Turnstile server-side validation is enabled. */
export function isTurnstileEnabled(): boolean {
  return !!process.env.TURNSTILE_SECRET_KEY;
}
