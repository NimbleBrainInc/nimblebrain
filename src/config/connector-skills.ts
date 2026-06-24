/**
 * Operator config for connector-skill overlays. Env-driven, resolved where
 * the lifecycle/loader needs it. Pure + injectable so the policy is
 * unit-testable without touching `process.env`.
 *
 * Overlays are curated usage guidance for connectors the platform doesn't
 * control (Composio + other third-party). They're fetched by connector identity
 * from a pinned PUBLIC repo and surfaced once into the conversation history on
 * first use — never into the system prefix.
 *
 * Opt-in: resolution is OFF unless the operator sets
 * `CONNECTOR_SKILLS_ENABLED=true`, because the curated repo is provisioned out
 * of band. `repo` / `version` are overridable to pin a fork or a newer release;
 * unset/blank falls back to the pinned defaults below.
 */

type Env = Record<string, string | undefined>;

/** Default curated overlay repo (`owner/repo`). Bump deliberately. */
export const CONNECTOR_SKILLS_REPO_DEFAULT = "NimbleBrainInc/connector-skills";

/** Default pinned git tag/sha for the overlay repo. */
export const CONNECTOR_SKILLS_VERSION_DEFAULT = "v0.1.0";

export interface ConnectorSkillsConfig {
  /** Whether overlay resolution runs at all (opt-in). */
  enabled: boolean;
  /** `owner/repo` of the curated overlay repo. */
  repo: string;
  /** Pinned git tag/sha resolved against. */
  version: string;
}

/**
 * Resolve connector-skill config from the environment.
 *
 * `enabled` is false unless `CONNECTOR_SKILLS_ENABLED` is an explicit truthy
 * value (`true` / `1`, case/whitespace-insensitive) — fail-closed so an unset
 * or malformed value never silently reaches out to a repo that may not exist
 * yet. `repo` / `version` fall back to the pinned defaults when unset/blank.
 */
export function resolveConnectorSkillsConfig(env: Env = process.env): ConnectorSkillsConfig {
  const enabledRaw = (env.CONNECTOR_SKILLS_ENABLED ?? "").trim().toLowerCase();
  const enabled = enabledRaw === "true" || enabledRaw === "1";
  const repo = (env.CONNECTOR_SKILLS_REPO ?? "").trim() || CONNECTOR_SKILLS_REPO_DEFAULT;
  const version = (env.CONNECTOR_SKILLS_VERSION ?? "").trim() || CONNECTOR_SKILLS_VERSION_DEFAULT;
  return { enabled, repo, version };
}
