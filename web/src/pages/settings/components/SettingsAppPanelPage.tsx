import type { ReactNode } from "react";
import { resolveIcon } from "../../../lib/icons";
import type { PlacementEntry } from "../../../types";
import { SettingsPageHeader } from "./SettingsPageHeader";

/**
 * Layout template for *bundle-provided* settings panels — the iframe-hosted
 * UIs registered by bundles via the `settings` placement slot.
 *
 * Without this template, navigating to `/settings/workspace/apps/<server>`
 * dropped the user into a raw, chromeless iframe with no indication that
 * they were still inside settings. This template provides the settings
 * frame consistently — bundle icon and title in the header, back-link to
 * the apps index, and a faint "provided by" footer below the iframe.
 *
 * The iframe is rendered flush — no outer ring or `bg-card`. Bundle UIs
 * already render their own complete content (headings, sections, save
 * bars), so wrapping them in host card chrome produces visible
 * cards-in-cards. This also matches the rule the sibling templates follow
 * (`SettingsFormPage` docstring): pages don't wrap content in cards.
 *
 * The credit is rendered as a footer (not a subtitle) so it recedes
 * properly. Subtitle position competes with the bundle's own internal
 * title for attention; footer position reads as a quiet attribution line.
 *
 * Theme propagation into the iframe is handled separately by `SlotRenderer`
 * (it injects CSS variables and pushes `host-context-changed` events on
 * theme/workspace switch); this template is purely host-side chrome.
 */
export interface SettingsAppPanelPageProps {
  panel: PlacementEntry;
  children: ReactNode;
}

export function SettingsAppPanelPage({ panel, children }: SettingsAppPanelPageProps) {
  const Icon = panel.icon ? resolveIcon(panel.icon) : null;
  const label = panel.label ?? panel.serverName;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 pb-4">
        <SettingsPageHeader
          title={label}
          icon={Icon ? <Icon className="h-5 w-5" /> : null}
          back={{ to: "/settings/workspace/apps", label: "Back to apps" }}
        />
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      <p className="shrink-0 pt-2 text-right text-xs text-muted-foreground">
        Provided by <code className="text-[11px]">{panel.serverName}</code>
      </p>
    </div>
  );
}
