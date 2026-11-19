import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "./_shared.ts";

// The plugin listing: `nb__manage_connectors` `list_plugins` (ADR-0068,
// ADR-0069 "Every listing says whose it is"). A client shows a plugin from these
// facts alone and needs no rule of its own to tell a personal plugin from a
// workspace one.

/** Whose plugin it is. A workspace plugin acts for every member; a person's acts only for them, where granted. */
export const PluginOwner = Type.Union([
  Type.Object({ kind: Type.Literal("workspace") }),
  Type.Object({ kind: Type.Literal("person") }),
]);
export type PluginOwner = Static<typeof PluginOwner>;

/**
 * The account a server's connection is signed in as: the display fields of the
 * identity its sign-in recorded. Never a token or any other credential.
 */
export const PluginAccount = Type.Object({
  email: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
});
export type PluginAccount = Static<typeof PluginAccount>;

/** A connection's status, the vocabulary `deriveConnectorStatus` decides. */
export const PluginServerStatus = StringEnum([
  "ready",
  "needs_setup",
  "not_connected",
  "needs_auth",
  "connecting",
  "failed",
  "starting",
] as const);
export type PluginServerStatus = Static<typeof PluginServerStatus>;

/** One server of a plugin: a connector, the connection to that server. */
export const PluginServer = Type.Object({
  /** The connector's server name: its tool namespace and the key every other `manage_connectors` action takes. */
  serverName: Type.String(),
  status: PluginServerStatus,
  /** Human-readable detail for `status`. */
  statusReason: Type.Optional(Type.String()),
  /** The signed-in account, or null when the connection records none (not connected, or API-key auth). */
  account: Type.Union([PluginAccount, Type.Null()]),
});
export type PluginServer = Static<typeof PluginServer>;

/** A skill that comes with the plugin: a curated overlay, or one its server publishes. */
export const PluginSkill = Type.Object({
  name: Type.String(),
  description: Type.Optional(Type.String()),
  kind: StringEnum(["overlay", "published"] as const),
  /** The server the skill is bound to. */
  serverName: Type.String(),
});
export type PluginSkill = Static<typeof PluginSkill>;

/** A view one of the plugin's servers places in the shell's sidebar. */
export const PluginApp = Type.Object({
  label: Type.String(),
  /** The server that places the view. */
  serverName: Type.String(),
  /** The `ui://` resource the view renders. */
  resourceUri: Type.String(),
  /** The view's route, opened at `/w/<workspace>/app/<route>`, when it declares one. */
  route: Type.Optional(Type.String()),
});
export type PluginApp = Static<typeof PluginApp>;

export const Plugin = Type.Object({
  /** Unique within the listing and stable across calls. Opaque: read `owner` and `servers`, never parse it. */
  id: Type.String(),
  displayName: Type.String(),
  iconUrl: Type.Optional(Type.String()),
  owner: PluginOwner,
  /**
   * Whether the plugin acts in the requested workspace. Always true for a
   * workspace plugin; for a person's plugin, whether its owner granted it here.
   */
  granted: Type.Boolean(),
  /** One or more servers. */
  servers: Type.Array(PluginServer),
  skills: Type.Array(PluginSkill),
  apps: Type.Array(PluginApp),
});
export type Plugin = Static<typeof Plugin>;

export const PluginsListOutput = Type.Object({
  /** The workspace the listing is for. */
  wsId: Type.String(),
  plugins: Type.Array(Plugin),
});
export type PluginsListOutput = Static<typeof PluginsListOutput>;

/**
 * `nb__request_plugin`: a model asks the caller to turn on one of their own
 * plugins in the workspace its run is in (ADR-0070). Its own tool, not a field
 * of `nb__manage_tools`: promotion is the native engine's state, which an
 * external agent runtime does not have, while a request touches none of it.
 */
export const RequestPluginInput = Type.Object(
  {
    plugin: Type.String({
      minLength: 1,
      description:
        "The exact name of one of the person's own plugins that nb__search lists as not turned on in this workspace.",
    }),
  },
  { required: ["plugin"], additionalProperties: false },
);
export type RequestPluginInput = Static<typeof RequestPluginInput>;

/**
 * A model's request to use one of the caller's own plugins in the workspace
 * its run is in (`nb__request_plugin`, ADR-0069 "Only the owner grants"). The
 * request writes nothing: a first-party client shows it to the plugin's owner,
 * and only their answer there writes the grant.
 */
export const PluginRequest = Type.Object({
  /** The plugin's server: the name `grant_connector` takes. */
  serverName: Type.String(),
  displayName: Type.String(),
  /** The account the plugin acts as, or null when its sign-in recorded none. */
  account: Type.Union([PluginAccount, Type.Null()]),
  /** The workspace the plugin would act in: the run's own. */
  wsId: Type.String(),
  workspaceName: Type.String(),
});
export type PluginRequest = Static<typeof PluginRequest>;

export const PluginRequestOutput = Type.Object({
  pluginRequest: PluginRequest,
});
export type PluginRequestOutput = Static<typeof PluginRequestOutput>;

/**
 * The person's answer to a plugin request, set by the client on the message
 * that tells the agent the answer (ADR-0070). The message's text is what the
 * agent reads; this lets a client show the message as the answer it is rather
 * than as something the person typed. It grants nothing.
 */
export const PluginRequestAnswer = Type.Object({
  /** The plugin's server, as the request named it. */
  serverName: Type.String(),
  answer: StringEnum(["use", "not_now"] as const),
});
export type PluginRequestAnswer = Static<typeof PluginRequestAnswer>;
