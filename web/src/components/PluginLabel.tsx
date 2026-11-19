import { UserRound } from "lucide-react";
import type { Plugin } from "../_generated/platform-schemas/plugins";
import { ConnectorIcon } from "./connectors/ConnectorIcon";

/**
 * Names the plugin behind a tool call or a loaded skill: its icon and display
 * name, quiet beside the row it labels. A person's own plugin carries a small
 * person badge, so a call made on the reader's own account reads differently
 * from one made on the workspace's.
 */
export function PluginLabel({ plugin }: { plugin: Plugin }) {
  const personal = plugin.owner.kind === "person";
  return (
    <span className="plugin-label" data-owner={plugin.owner.kind}>
      <ConnectorIcon
        name={plugin.displayName}
        iconUrl={plugin.iconUrl}
        className="plugin-label__icon h-3 w-3 rounded-sm text-[8px]"
      />
      <span className="plugin-label__name">{plugin.displayName}</span>
      {personal && (
        <span className="plugin-label__yours" title="Yours">
          <UserRound aria-hidden style={{ width: 10, height: 10 }} />
          <span className="sr-only">Yours</span>
        </span>
      )}
    </span>
  );
}
