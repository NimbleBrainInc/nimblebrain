import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { BundleManifest } from "./types.ts";

const SUPPORTED_VERSIONS = ["0.3", "0.4"] as const;

const schemasDir = join(import.meta.dir, "schemas");

const schemaMap = new Map<string, object>();
for (const version of SUPPORTED_VERSIONS) {
  const raw = readFileSync(join(schemasDir, `mcpb-manifest-v${version}.schema.json`), "utf-8");
  schemaMap.set(version, JSON.parse(raw));
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// Pre-compile validators for each version
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
for (const [version, schema] of schemaMap) {
  validators.set(version, ajv.compile(schema));
}

// Pre-compile host manifest extension validator
const hostSchemaRaw = readFileSync(join(schemasDir, "host-manifest.schema.json"), "utf-8");
const hostValidator = ajv.compile(JSON.parse(hostSchemaRaw));

export interface ManifestValidationResult {
  valid: boolean;
  manifest: BundleManifest | null;
  errors: string[];
  version: string | null;
}

/**
 * Parse and validate a MCPB manifest.json.
 *
 * Detects the manifest version from manifest_version or dxt_version,
 * validates against the matching schema, and returns a typed manifest.
 * Supports v0.3 and v0.4.
 */
export function validateManifest(raw: Record<string, unknown>): ManifestValidationResult {
  // Detect version
  const version = (raw.manifest_version ?? raw.dxt_version ?? null) as string | null;

  if (!version) {
    return {
      valid: false,
      manifest: null,
      errors: [
        `Missing manifest_version (or dxt_version). Supported: ${SUPPORTED_VERSIONS.join(", ")}`,
      ],
      version: null,
    };
  }

  if (!SUPPORTED_VERSIONS.includes(version as (typeof SUPPORTED_VERSIONS)[number])) {
    return {
      valid: false,
      manifest: null,
      errors: [
        `Unsupported manifest_version "${version}". Supported: ${SUPPORTED_VERSIONS.join(", ")}`,
      ],
      version,
    };
  }

  const validate = validators.get(version)!;
  const valid = validate(raw);

  if (!valid) {
    const errors = (validate.errors ?? []).map((e) => {
      const path = e.instancePath || "(root)";
      return `${path}: ${e.message}`;
    });
    return { valid: false, manifest: null, errors, version };
  }

  return {
    valid: true,
    manifest: raw as unknown as BundleManifest,
    errors: [],
    version,
  };
}

export interface HostMetaValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate the _meta["ai.nimblebrain/host"] block, if present.
 * Returns valid: true when the block is absent (it's optional).
 */
export function validateHostMeta(
  meta: Record<string, unknown> | undefined,
): HostMetaValidationResult {
  const hostBlock = meta?.["ai.nimblebrain/host"];
  if (!hostBlock) return { valid: true, errors: [] };

  const valid = hostValidator(hostBlock);
  if (!valid) {
    const errors = (hostValidator.errors ?? []).map((e) => {
      const path = e.instancePath || "(root)";
      return `ai.nimblebrain/host${path}: ${e.message}`;
    });
    return { valid: false, errors };
  }
  return { valid: true, errors: [] };
}
