import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { log } from "../cli/log.ts";
import type { EventSink } from "../engine/types.ts";
import { McpSource } from "../tools/mcp-source.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolSource } from "../tools/types.ts";
import { extractBundleMeta } from "./defaults.ts";
import { filterEnvForBundle } from "./env-filter.ts";
import { validateManifest } from "./manifest.ts";
import { getMpak } from "./mpak.ts";
import { deriveBundleDataDir, deriveServerName, validateServerName } from "./paths.ts";
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
    const nbWorkDir = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
    const bundleDataDir = opts?.dataDir ?? join(nbWorkDir, "data", deriveBundleDataDir(ref.name));

    const mpakHome = process.env.MPAK_HOME ?? join(homedir(), ".mpak");
    const mpak = getMpak(mpakHome);
    const server = await mpak.prepareServer({ name: ref.name }, { workspaceDir: bundleDataDir });

    // Read cached manifest for UI + briefing metadata + return to caller
    const cachedManifest = mpak.bundleCache.getBundleManifest(ref.name) as BundleManifest | null;
    if (cachedManifest) {
      meta = extractBundleMeta(cachedManifest as unknown as Record<string, unknown>);
      manifest = cachedManifest;
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

  const spawnEnv: Record<string, string> = {
    ...filterEnvForBundle(process.env as Record<string, string>, mcpConfig.env, ref.allowedEnv),
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
