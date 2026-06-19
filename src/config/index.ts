import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ValidateFunction } from "ajv";
import Ajv from "ajv";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the config schema. This file is the canonical source: the
 * runtime validates nimblebrain.json against it, and `.github/workflows/schema-deploy.yml`
 * publishes it to schemas.nimblebrain.ai on change. Keep it in lockstep with the
 * feature surface — `test/unit/config-schema-drift.test.ts` guards the drift.
 */
export const SCHEMA_PATH = resolve(__dirname, "nimblebrain-config.schema.json");

let _validate: ValidateFunction | null = null;

/** Lazily compiled AJV validate function for nimblebrain.json. */
export function getValidator(): ValidateFunction {
  if (!_validate) {
    const schema = require(SCHEMA_PATH);
    const ajv = new Ajv({ allErrors: true, strict: false });
    _validate = ajv.compile(schema);
  }
  return _validate;
}
