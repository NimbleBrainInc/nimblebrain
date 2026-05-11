import { Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { callTool, getPlatformVersion, uploadBundle } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { EmptyState, InlineError, Section, SettingsDashboardPage } from "./components";

interface AppInfo {
  name: string;
  bundleName: string;
  version: string;
  status: string;
  type: string;
  toolCount: number;
}

function mpakUrl(bundleName: string): string | null {
  // Scoped names like @nimblebraininc/echo → mpak.dev/packages/@nimblebraininc/echo
  if (bundleName.startsWith("@")) return `https://mpak.dev/packages/${bundleName}`;
  return null;
}

function statusColor(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "running":
      return "default";
    case "starting":
      return "secondary";
    case "crashed":
    case "dead":
      return "destructive";
    default:
      return "outline";
  }
}

/**
 * About — read-only platform info + the bundles installed on this
 * instance.
 *
 * The bundle table duplicates data also visible in Settings →
 * Workspace → Connectors. We keep both surfaces during the bake-in
 * period for the new Connectors UX: About is a known-good fallback
 * that doesn't depend on the new code paths (manage_connectors
 * tool, registry abstraction, permission store), so if anything in
 * Connectors regresses, operators have somewhere stable to verify
 * "is my bundle actually running?". When Connectors is proven in
 * production we'll re-remove this section — tracked separately.
 */
export function AboutTab() {
  const { version, buildSha } = getPlatformVersion();
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [bundlesError, setBundlesError] = useState<string | null>(null);
  // Two pieces of upload state, separated:
  //
  //   uploadPhase  — what the upload is doing right now ("validating" /
  //                  "installing" / "idle"). Drives the button label and
  //                  the disabled state. `isUploading` is derived from it.
  //   uploadError  — error message to surface in the inline-error panel.
  //                  Independent so we can show "validation failed" without
  //                  string-equality-checking the phase.
  //
  // Previous shape used a single `uploadStatus: string | null` that doubled
  // as both phase indicator and error message, requiring string-equality
  // checks ("Validating..." / "Installing...") to decide whether the button
  // should be disabled. That coupled the UI to specific status copy and
  // would silently break if the strings were ever changed.
  const [uploadPhase, setUploadPhase] = useState<"idle" | "validating" | "installing">("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const isUploading = uploadPhase !== "idle";
  const fileRef = useRef<HTMLInputElement>(null);

  const fetchApps = useCallback(async () => {
    try {
      setBundlesError(null);
      const result = await callTool("nb", "list_apps", {});
      const data = parseToolResult<{ apps?: AppInfo[] }>(result);
      if (Array.isArray(data.apps)) {
        setApps(data.apps);
      }
    } catch (err) {
      setBundlesError(err instanceof Error ? err.message : "Failed to load installed bundles.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  const handleUpload = useCallback(
    async (file: File) => {
      if (!file.name.endsWith(".mcpb")) {
        setUploadError("File must have .mcpb extension");
        return;
      }
      setUploadError(null);
      setUploadPhase("validating");
      try {
        const result = await uploadBundle(file);
        setUploadPhase("installing");
        const installResult = await callTool("nb", "manage_app", {
          action: "install",
          path: result.path,
        });
        if (installResult.isError) {
          const msg =
            installResult.content
              ?.filter(
                (c): c is { type: "text"; text: string } =>
                  c.type === "text" && typeof c.text === "string",
              )
              .map((c) => c.text)
              .join("") ?? "Install failed";
          setUploadError(msg);
          return;
        }
        setLoading(true);
        fetchApps();
      } catch (err: unknown) {
        setUploadError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploadPhase("idle");
      }
    },
    [fetchApps],
  );

  return (
    <SettingsDashboardPage
      title="About"
      description="Platform version and the bundles installed on this instance."
    >
      <Section title="Platform" flush>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Version</dt>
          <dd className="font-mono">{version ?? "unknown"}</dd>
          <dt className="text-muted-foreground">Build</dt>
          <dd className="font-mono">{buildSha ?? "dev"}</dd>
        </dl>
      </Section>

      <Section
        title="Installed Bundles"
        action={
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".mcpb"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={isUploading}
            >
              <Upload className="mr-1 h-3.5 w-3.5" />
              {uploadPhase === "validating"
                ? "Validating..."
                : uploadPhase === "installing"
                  ? "Installing..."
                  : "Upload"}
            </Button>
          </>
        }
      >
        <p className="text-xs text-muted-foreground mb-3">
          Read-only view (apart from .mcpb upload). Manage installed bundles in{" "}
          <Link
            to="/settings/workspace/connectors"
            className="text-primary underline-offset-4 hover:underline"
          >
            Settings → Workspace → Connectors
          </Link>
          .
        </p>
        {uploadError ? (
          <InlineError
            message={uploadError}
            action={
              <Button variant="outline" size="sm" onClick={() => setUploadError(null)}>
                Dismiss
              </Button>
            }
          />
        ) : null}

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : bundlesError ? (
          <InlineError
            message={bundlesError}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setLoading(true);
                  fetchApps();
                }}
              >
                Retry
              </Button>
            }
          />
        ) : apps.length === 0 ? (
          <EmptyState message="No bundles installed." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Tools</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((app) => {
                const href = mpakUrl(app.bundleName);
                return (
                  <TableRow key={app.bundleName}>
                    <TableCell className="font-mono text-xs">
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {app.bundleName}
                        </a>
                      ) : (
                        app.bundleName
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{app.version || "—"}</TableCell>
                    <TableCell>
                      <Badge variant={statusColor(app.status)} className="text-xs">
                        {app.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{app.toolCount}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>
    </SettingsDashboardPage>
  );
}
