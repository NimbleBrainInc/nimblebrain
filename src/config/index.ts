import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SchemaValidateFunction, ValidateFunction } from "ajv";
import Ajv from "ajv";
import { findInlineKeyMaterial } from "./secrets.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the config schema. This file is the canonical source: the
 * runtime validates nimblebrain.json against it, and `.github/workflows/schema-deploy.yml`
 * publishes it to schemas.nimblebrain.ai on change. Keep it in lockstep with the
 * feature surface — `test/unit/config-schema-drift.test.ts` guards the drift.
 */
export const SCHEMA_PATH = resolve(__dirname, "nimblebrain-config.schema.json");

/**
 * Schema keyword: this subtree must not carry key material. Declared on
 * `secrets.config`, whose whole contract is to name where a key lives rather
 * than to hold one.
 *
 * A keyword rather than a check bolted onto one caller, so the rule travels
 * with the schema — the published document a reader consults says the subtree
 * is guarded, and every compile of that schema enforces it. See
 * `secrets.ts` for why it is enforced at all.
 */
export const NO_INLINE_KEY_MATERIAL_KEYWORD = "nbNoInlineKeyMaterial";

/**
 * One AJV instance shape for every compile of this schema. A second factory
 * that forgot the keyword would compile the same document with the guard
 * silently absent — AJV runs non-strict, so an unknown keyword is ignored
 * rather than rejected.
 */
function createAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate: SchemaValidateFunction = (schemaValue: unknown, data: unknown) => {
    if (schemaValue !== true) return true;
    const reason = findInlineKeyMaterial(data);
    if (!reason) return true;
    // `instancePath` and `schemaPath` are deliberately left to AJV, which fills
    // them from where the keyword sits. Setting them here to "" is what makes a
    // violation inside `secrets.config` print as `(root)` — the one field an
    // operator reads to find it.
    validate.errors = [{ keyword: NO_INLINE_KEY_MATERIAL_KEYWORD, params: {}, message: reason }];
    return false;
  };
  ajv.addKeyword({
    keyword: NO_INLINE_KEY_MATERIAL_KEYWORD,
    schemaType: "boolean",
    errors: true,
    validate,
  });
  return ajv;
}

let _validate: ValidateFunction | null = null;
let _connectorRefValidate: ValidateFunction | null = null;

/** Lazily compiled AJV validate function for nimblebrain.json. */
export function getValidator(): ValidateFunction {
  if (!_validate) {
    const schema = require(SCHEMA_PATH);
    _validate = createAjv().compile(schema);
  }
  return _validate;
}

/**
 * Validate function for one entry in a workspace's `connectors[]`.
 *
 * The shape lives in the same published schema (`$defs/connectorRef`) even
 * though it belongs to `workspace.json`: that file is written by the platform
 * rather than by hand and has no schema of its own, and one published document
 * is what keeps the definition somewhere an operator can read it.
 */
export function getConnectorRefValidator(): ValidateFunction {
  if (!_connectorRefValidate) {
    const schema = require(SCHEMA_PATH);
    _connectorRefValidate = createAjv().compile({
      ...schema.$defs.connectorRef,
      $defs: schema.$defs,
    });
  }
  return _connectorRefValidate;
}
