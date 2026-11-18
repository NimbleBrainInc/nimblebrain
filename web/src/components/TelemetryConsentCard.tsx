import { useEffect, useState } from "react";
import { callToolWithoutWorkspace } from "../api/client";
import { roleAtLeast, useScopedRole } from "../hooks/useScopedRole";
import { initTelemetry } from "../telemetry";
import { useTourRunning } from "./tour/OverviewTour";
import { Button } from "./ui/button";

interface TelemetryInfo {
  installId?: string;
  telemetry?: { consent?: string; locked?: string };
}

/**
 * Asks an org admin, once, whether this install may send anonymous usage
 * telemetry, when no one has answered yet (`consent: "undecided"`). Nothing is
 * sent before the answer. Renders nothing when the deployment decided
 * (`locked`), when the install has nowhere to send it, after an answer, on
 * the icon rail, where there is no room to ask properly, or while the tour is
 * on screen, so a first visit asks one thing at a time.
 *
 * The answer is the install's, kept by the runtime, so the CLI's `telemetry`
 * command and this card set the same thing.
 */
export function TelemetryConsentCard({ collapsed = false }: { collapsed?: boolean }) {
  const isOrgAdmin = roleAtLeast(useScopedRole(), "org_admin");
  const [info, setInfo] = useState<TelemetryInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // One ask at a time: the question waits while the tour is on screen.
  const tourRunning = useTourRunning();

  useEffect(() => {
    if (!isOrgAdmin) return;
    callToolWithoutWorkspace("nb", "workspace_info", {})
      .then((res) => setInfo((res.structuredContent ?? null) as TelemetryInfo | null))
      .catch(() => {});
  }, [isOrgAdmin]);

  const t = info?.telemetry;
  if (collapsed || tourRunning || !isOrgAdmin || t?.consent !== "undecided" || t.locked)
    return null;

  const answer = (consent: "on" | "off") => {
    setBusy(true);
    callToolWithoutWorkspace("nb", "set_telemetry", { consent })
      .then((res) => {
        if (res.isError) return;
        if (consent === "on" && info?.installId) initTelemetry(info.installId);
        setInfo({ ...info, telemetry: { consent } });
      })
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  return (
    <fieldset
      data-testid="telemetry-consent"
      className="mx-2 mb-2 min-w-0 shrink-0 rounded-sm border border-sidebar-border bg-sidebar-accent/40 px-2.5 py-2 text-xs text-foreground"
    >
      <legend className="sr-only">Usage data</legend>
      <p className="font-medium">Help improve NimbleBrain?</p>
      <p className="mt-1 text-muted-foreground">
        Send anonymous usage data. No prompts, content, names or keys are sent.{" "}
        <a
          href="https://docs.nimblebrain.ai/using/telemetry/"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          What is sent
        </a>
      </p>
      <div className="mt-1.5 flex gap-1.5">
        <Button
          size="sm"
          className="flex-1"
          disabled={busy}
          onClick={() => answer("on")}
          data-testid="telemetry-consent-on"
        >
          Send
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="flex-1"
          disabled={busy}
          onClick={() => answer("off")}
          data-testid="telemetry-consent-off"
        >
          Don't send
        </Button>
      </div>
    </fieldset>
  );
}
