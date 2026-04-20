import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { log } from "../cli/log.ts";
import {
  friendlyMpakConfigError,
  resolveUserConfig,
  type UserConfigFieldDef,
} from "../config/workspace-credentials.ts";
import type { EventSink } from "../engine/types.ts";
import { McpSource } from "../tools/mcp-source.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolSource } from "../tools/types.ts";
import { extractBundleMeta } from "./defaults.ts";
import { filterEnvForBundle } from "./env-filter.ts";
import { validateManifest } from "./manifest.ts";
import { getMpak } from "./mpak.ts";
import {
  deriveBundleDataDir,
  deriveServerName,
  resolveBundleDataDir,
  validateServerName,
} from "./paths.ts";
import { resolveLocalBundle } from "./resolve.ts";
import type {
  BundleManifest,
  BundleRef,
  InternalBundleEnv,
  LocalBundleMeta,
  StartBundleResult,
} from "./types.ts";
import { validateBundleUrl } from "./url-validator.ts";

/** Create and start a McpSource for a BundleRef, then add to registry.
 *  Returns manifest metadata and actual source name for local bundles. */
export async function startBundleSource(
  ref: BundleRef,
  registry: ToolRegistry,
  // Required. The runtime event sink is threaded into the McpSource so
  // task-augmented tool calls can emit `tool.progress` events that reach the
  // SSE broadcast path; the browser side of Synapse `useDataSync` depends on
  // it. Callers without a real sink (rare) must pass `new NoopEventSink()`
  // explicitly — the absence used to be silently valid, which broke live
  // updates across the entire platform.
  eventSink: EventSink,
  configDir?: string,
  opts?: {
    allowInsecureRemotes?: boolean;
    internalEnv?: InternalBundleEnv;
    dataDir?: string;
    /**
     * Workspace id for credential resolution. Required for named bundles — the
     * named-bundle path resolves `user_config` via `resolveUserConfig` which is
     * workspace-scoped by design. Unused for URL and local-path bundles, which
     * don't go through `prepareServer` for `user_config`.
     */
    wsId?: string;
    /**
     * Work directory for credential resolution. Defaults to `NB_WORK_DIR` or
     * `~/.nimblebrain` — the same default the named-bundle branch already uses
     * for `bundleDataDir`.
     */
    workDir?: string;
  },
): Promise<StartBundleResult> {
  if ("url" in ref) {
    const serverName = ref.serverName ?? deriveServerName(ref.url);
    validateServerName(serverName);
    const sourceName = serverName;
    // SSRF protection: validate URL before connecting
    validateBundleUrl(new URL(ref.url), { allowInsecure: opts?.allowInsecureRemotes });
    log.info(`[bundles] Starting remote bundle ${ref.url} as ${sourceName}...`);
    const source = new McpSource(
      sourceName,
      {
        type: "remote",
        url: new URL(ref.url),
        transportConfig: ref.transport,
      },
      eventSink,
    );
    await source.start();
    const tools = await source.tools();
    registry.addSource(source);
    log.info(`[bundles] ✓ ${sourceName} ready (${tools.length} tools, remote)`);
    return {
      meta: {
        version: `remote (${tools.length} tools)`,
        ui: ref.ui ?? null,
        briefing: null,
        type: "plain" as const,
      },
      sourceName,
      // Remote bundles have no local manifest — the platform reads tools
      // over the wire instead.
      manifest: null,
    };
  }
  const label = "name" in ref ? ref.name : ref.path;
  log.info(`[bundles] Starting ${label}...`);

  let source: ToolSource;
  let meta: LocalBundleMeta | null = null;
  let manifest: BundleManifest | null = null;
  if ("name" in ref) {
    const serverName = deriveServerName(ref.name);
    validateServerName(serverName);
    const sourceName = serverName;

    // Named bundles are workspace-scoped. The caller must supply `wsId`;
    // without it we have no workspace to resolve credentials against and
    // no way to pick a consistent data dir. This throw is the end of the
    // named-bundle path — the platform has a bug if a caller reaches here
    // without a workspace context.
    if (!opts?.wsId) {
      throw new Error(
        `Cannot start ${ref.name}: a workspace ID is required (platform bug — please report).`,
      );
    }

    const nbWorkDir = opts.workDir ?? process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
    // Data dir derives from wsId + workDir. Callers only pass `opts.dataDir`
    // to override for test fixtures. This is the single source of truth for
    // the layout — lifecycle.installNamed, workspace-ops, and workspace-
    // runtime all produce paths matching this derivation, so there is no
    // drift class between "where a bundle gets installed" and "where it
    // spawns when restarted."
    const bundleDataDir =
      opts.dataDir ?? resolveBundleDataDir(join(nbWorkDir, "workspaces", opts.wsId), ref.name);

    const mpakHome = process.env.MPAK_HOME ?? join(homedir(), ".mpak");
    const mpak = getMpak(mpakHome);

    // Read cached manifest up-front so we can discover the user_config schema
    // and resolve credentials BEFORE prepareServer validates them. The mpak
    // cache is populated during install (see BundleLifecycleManager.installNamed
    // or mpak install), so we expect the manifest to be present here.
    const cachedManifest = mpak.bundleCache.getBundleManifest(ref.name) as
      | (BundleManifest & { user_config?: Record<string, UserConfigFieldDef> })
      | null;
    if (cachedManifest) {
      meta = extractBundleMeta(cachedManifest as unknown as Record<string, unknown>);
      manifest = cachedManifest;
    }

    // Read host-side credentials from the workspace credential store. The
    // mpak SDK does the rest of the resolution chain: manifest-declared
    // mcp_config.env aliases (so a bundle with
    // `"NEWSAPI_API_KEY": "${user_config.api_key}"` is satisfied by a host
    // NEWSAPI_API_KEY export) and manifest defaults. Any still-missing
    // required field surfaces as MpakConfigError, which we translate to
    // the familiar `nb config set -w <wsId>` hint.
    const userConfig = await resolveUserConfig({
      bundleName: ref.name,
      userConfigSchema: cachedManifest?.user_config,
      wsId: opts.wsId,
      workDir: nbWorkDir,
    });

    let server: Awaited<ReturnType<typeof mpak.prepareServer>>;
    try {
      server = await mpak.prepareServer(
        { name: ref.name },
        { workspaceDir: bundleDataDir, userConfig },
      );
    } catch (err) {
      // MpakConfigError (0.5.0+) carries envAliases per missing field,
      // so friendlyMpakConfigError can name `export ANTHROPIC_API_KEY`
      // hints without us threading the manifest through.
      throw friendlyMpakConfigError(err, opts.wsId);
    }

    source = new McpSource(
      sourceName,
      {
        type: "stdio",
        spawn: {
          command: server.command,
          args: server.args,
          env: {
            ...server.env,
            ...filterEnvForBundle(process.env as Record<string, string>, undefined, ref.allowedEnv),
            ...(ref.env ?? {}),
            MPAK_WORKSPACE: bundleDataDir,
            UPJACK_ROOT: bundleDataDir,
          },
          cwd: server.cwd,
        },
      },
      eventSink,
    );
  } else {
    const internalEnv = ref.protected && opts?.internalEnv ? opts.internalEnv : undefined;
    const result = buildLocalSource(ref, configDir, internalEnv, opts?.dataDir, eventSink);
    source = result.source;
    meta = result.meta;
    manifest = result.manifest;
  }

  await source.start();
  const tools = await source.tools();
  registry.addSource(source);
  log.info(`[bundles] ✓ ${source.name} ready (${tools.length} tools)`);
  return { meta, sourceName: source.name, manifest };
}

/** Build an McpSource from a local bundle path + manifest, extracting UI metadata.
 *  Local bundles are unpacked directories — the SDK's prepareServer({ local }) expects
 *  .mcpb archives, so we handle local paths directly. */
function buildLocalSource(
  ref: {
    path: string;
    env?: Record<string, string>;
    allowedEnv?: string[];
  },
  configDir: string | undefined,
  internalEnv: InternalBundleEnv | undefined,
  dataDirOverride: string | undefined,
  eventSink: EventSink,
): { source: McpSource; meta: LocalBundleMeta; manifest: BundleManifest } {
  const bundleDir = resolveLocalBundle(ref.path, configDir);
  if (!bundleDir) {
    log.warn(`[bundles] Local bundle not found: ${ref.path} (skipping)`);
    throw new Error(`Local bundle not found: ${ref.path}`);
  }

  const manifestPath = join(bundleDir, "manifest.json");
  const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const result = validateManifest(raw);
  if (!result.valid || !result.manifest) {
    throw new Error(`Invalid manifest in ${ref.path}:\n${result.errors.join("\n")}`);
  }

  const manifest = result.manifest;
  const serverName = deriveServerName(manifest.name);
  validateServerName(serverName);
  const mcpConfig = manifest.server.mcp_config;

  let command = mcpConfig.command;
  const args = (mcpConfig.args ?? []).map((arg) =>
    arg.replace(/\$\{__dirname\}/g, resolve(bundleDir)),
  );

  // Resolve user_config placeholders in mcp_config.env against process.env.
  // The named-bundle branch gets this for free from `mpak.prepareServer` which
  // calls the SDK's `gatherUserConfig` (env-alias tier) + `substituteEnvVars`.
  // Local-path bundles don't go through prepareServer, so without this the
  // literal string `${user_config.foo}` would end up as a subprocess env value.
  const userConfigSchema = (manifest as { user_config?: Record<string, UserConfigFieldDef> })
    .user_config;
  const resolvedMcpEnv = substituteUserConfigFromEnv(
    mcpConfig.env ?? {},
    userConfigSchema,
    process.env as Record<string, string>,
  );

  const spawnEnv: Record<string, string> = {
    ...filterEnvForBundle(process.env as Record<string, string>, resolvedMcpEnv, ref.allowedEnv),
    ...(ref.env ?? {}),
  };

  // Inject internal auth env for protected default bundles
  if (internalEnv) {
    spawnEnv.NB_INTERNAL_TOKEN = internalEnv.NB_INTERNAL_TOKEN;
    spawnEnv.NB_HOST_URL = internalEnv.NB_HOST_URL;
  }

  // Per-bundle data isolation — each bundle gets its own directory under data/
  const nbWorkDir = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
  const bundleDataDir =
    dataDirOverride ?? join(nbWorkDir, "data", deriveBundleDataDir(manifest.name));
  spawnEnv.MPAK_WORKSPACE = bundleDataDir;
  spawnEnv.UPJACK_ROOT = bundleDataDir;

  // Python bundles: resolve "python" -> "python3" if needed, build PYTHONPATH
  if (manifest.server.type === "python") {
    if (command === "python") {
      const check = Bun.spawnSync(["which", "python"]);
      if (check.exitCode !== 0) command = "python3";
    }
    const resolvedDir = resolve(bundleDir);
    const pathParts: string[] = [];
    const depsDir = join(resolvedDir, "deps");
    if (existsSync(depsDir)) pathParts.push(depsDir);
    const srcDir = join(resolvedDir, "src");
    if (existsSync(srcDir)) pathParts.push(srcDir);
    if (pathParts.length > 0) {
      const existing = spawnEnv.PYTHONPATH;
      spawnEnv.PYTHONPATH = existing ? `${pathParts.join(":")}:${existing}` : pathParts.join(":");
    }
  }

  const sourceName = serverName;
  const source = new McpSource(
    sourceName,
    {
      type: "stdio",
      spawn: {
        command,
        args,
        env: spawnEnv,
        cwd: resolve(bundleDir),
      },
    },
    eventSink,
  );

  return {
    source,
    meta: extractBundleMeta(manifest as unknown as Record<string, unknown>),
    manifest,
  };
}

/**
 * Substitute `${user_config.<field>}` placeholders in a bundle's
 * `mcp_config.env` using values reverse-looked-up from `processEnv`.
 *
 * Mirrors the env-alias tier of the mpak SDK's private `gatherUserConfig` +
 * `substituteEnvVars` (see mpak-sdk@0.5.0). The named-bundle branch of
 * `startBundleSource` gets this by calling `mpak.prepareServer`; the local-path
 * branch (`buildLocalSource`) bypasses the SDK, so we replicate the tier here.
 *
 * The reverse-lookup is intentionally narrow: for each declared `user_config`
 * field, we scan `mcp_config.env` for entries whose value references that
 * field via `${user_config.<field>}`, then try the first such env-var name in
 * `processEnv`. A bundle declaring `"ANTHROPIC_API_KEY": "${user_config.anthropic_api_key}"`
 * is satisfied by a host `ANTHROPIC_API_KEY` export.
 *
 * Unresolved placeholders collapse to an empty string — matching the SDK's
 * substitution behavior when a field has no value. Required-field validation
 * is NOT performed here; the bundle subprocess surfaces the concrete error
 * (e.g. Anthropic's 401) which is more actionable than a generic host error.
 */
function substituteUserConfigFromEnv(
  mcpConfigEnv: Record<string, string>,
  userConfigSchema: Record<string, UserConfigFieldDef> | undefined,
  processEnv: Record<string, string>,
): Record<string, string> {
  if (!userConfigSchema || Object.keys(userConfigSchema).length === 0) {
    return { ...mcpConfigEnv };
  }

  const values: Record<string, string> = {};
  for (const fieldKey of Object.keys(userConfigSchema)) {
    const placeholder = `\${user_config.${fieldKey}}`;
    for (const [envVarName, envVarValue] of Object.entries(mcpConfigEnv)) {
      if (envVarValue.includes(placeholder)) {
        const v = processEnv[envVarName];
        if (v !== undefined && v !== "") {
          values[fieldKey] = v;
          break;
        }
      }
    }
  }

  const substituted: Record<string, string> = {};
  for (const [k, v] of Object.entries(mcpConfigEnv)) {
    substituted[k] = v.replace(
      /\$\{user_config\.(\w+)\}/g,
      (_match, fieldKey: string) => values[fieldKey] ?? "",
    );
  }
  return substituted;
}
