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
 * Always on, self-gating: an overlay exists only when WE curate one for a
 * connector, so a connector with no overlay is a fail-soft no-op (the fetch
 * 404s, the install proceeds). No on/off flag — there's nothing to disable.
 * `repo` / `version` are overridable to pin a fork or a newer release; unset or
 * blank falls back to the pinned defaults below.
 */

type Env = Record<string, string | undefined>;

/** Default curated overlay repo (`owner/repo`). Bump deliberately. */
export const CONNECTOR_SKILLS_REPO_DEFAULT = "NimbleBrainInc/connector-skills";

/** Default pinned git tag/sha for the overlay repo. */
export const CONNECTOR_SKILLS_VERSION_DEFAULT = "v0.2.0";

export interface ConnectorSkillsConfig {
  /** `owner/repo` of the curated overlay repo. */
  repo: string;
  /** Pinned git tag/sha resolved against. */
  version: string;
}

/**
 * Resolve connector-skill config from the environment. `repo` / `version` fall
 * back to the pinned defaults when unset/blank.
 */
export function resolveConnectorSkillsConfig(env: Env = process.env): ConnectorSkillsConfig {
  const repo = (env.CONNECTOR_SKILLS_REPO ?? "").trim() || CONNECTOR_SKILLS_REPO_DEFAULT;
  const version = (env.CONNECTOR_SKILLS_VERSION ?? "").trim() || CONNECTOR_SKILLS_VERSION_DEFAULT;
  return { repo, version };
}
