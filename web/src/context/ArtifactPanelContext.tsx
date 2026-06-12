// ---------------------------------------------------------------------------
// ArtifactPanelContext — global state for the document/artifact drawer.
//
// An "artifact" is any resource_link a tool emits that deserves a document
// surface rather than an inline box in the chat stream: a deep-research
// report, a generated markdown doc, anything readable-long. The chip in the
// stream is just the reference; opening it pushes the descriptor here and the
// single global <ArtifactPanel> (mounted once by ShellLayout, like
// ChatChrome) fetches and renders it.
//
// Mirrors ChatPanelContext's shape on purpose: one provider owns the open
// descriptor, a global mount reads it, every chip across every conversation
// opens into the same drawer.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

/** The minimal descriptor needed to fetch + render an artifact resource. */
export interface ArtifactDescriptor {
  /** Server/app that owns the resource — forwarded to POST /v1/resources/read. */
  appName: string;
  /** Resource URI from the resource_link block (e.g. `files://<id>`). */
  uri: string;
  /** Display title from the resource_link `name`. */
  name?: string;
  /** Declared MIME type (e.g. `text/markdown`). */
  mimeType?: string;
  /** Optional description surfaced in the panel header. */
  description?: string;
}

export interface ArtifactPanelContextValue {
  /** The currently-open artifact, or null when the panel is closed. */
  artifact: ArtifactDescriptor | null;
  /** Open the document panel for the given artifact. */
  openArtifact: (artifact: ArtifactDescriptor) => void;
  /** Close the panel. */
  closeArtifact: () => void;
}

const ArtifactPanelContext = createContext<ArtifactPanelContextValue | null>(null);

export function ArtifactPanelProvider({ children }: { children: ReactNode }) {
  const [artifact, setArtifact] = useState<ArtifactDescriptor | null>(null);

  const openArtifact = useCallback((next: ArtifactDescriptor) => {
    setArtifact(next);
  }, []);

  const closeArtifact = useCallback(() => {
    setArtifact(null);
  }, []);

  const value = useMemo<ArtifactPanelContextValue>(
    () => ({ artifact, openArtifact, closeArtifact }),
    [artifact, openArtifact, closeArtifact],
  );

  return <ArtifactPanelContext value={value}>{children}</ArtifactPanelContext>;
}

/** Consume the ArtifactPanelContext. Throws if used outside the provider. */
export function useArtifactPanel(): ArtifactPanelContextValue {
  const ctx = useContext(ArtifactPanelContext);
  if (!ctx) {
    throw new Error("useArtifactPanel must be used within an ArtifactPanelProvider");
  }
  return ctx;
}
