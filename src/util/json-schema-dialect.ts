/**
 * Compile a JSON Schema with the Ajv dialect its `$schema` names.
 *
 * A default `Ajv` knows only draft-07, so compiling a schema that declares
 * 2020-12 (what Zod v4's `toJSONSchema` emits) throws `no schema with key or
 * ref`. Each dialect gets its own instance. A schema with no `$schema`, or one
 * naming draft-07, compiles as draft-07: MCP makes 2020-12 the default for an
 * undeclared tool schema, but draft-07-only constructs (array-form `items`)
 * fail to compile under 2020-12, and those schemas validate correctly today.
 *
 * `addUsedSchema: false` keeps one schema's `$id` out of the instance, so two
 * unrelated schemas sharing an `$id` both compile.
 */

import Ajv, { type ValidateFunction } from "ajv";
import Ajv2019 from "ajv/dist/2019";
import Ajv2020 from "ajv/dist/2020";

const OPTIONS = { allErrors: true, strict: false, addUsedSchema: false } as const;

type Dialect = "draft-07" | "2019-09" | "2020-12";

const DIALECT_BY_URI: Record<string, Dialect> = {
  "https://json-schema.org/draft/2020-12/schema": "2020-12",
  "https://json-schema.org/draft/2019-09/schema": "2019-09",
};

const instances = new Map<Dialect, Ajv>();

function ajvFor(dialect: Dialect): Ajv {
  let ajv = instances.get(dialect);
  if (!ajv) {
    ajv =
      dialect === "2020-12"
        ? new Ajv2020(OPTIONS)
        : dialect === "2019-09"
          ? new Ajv2019(OPTIONS)
          : new Ajv(OPTIONS);
    instances.set(dialect, ajv);
  }
  return ajv;
}

function dialectOf(schema: Record<string, unknown>): Dialect {
  const uri = schema.$schema;
  if (typeof uri !== "string") return "draft-07";
  return DIALECT_BY_URI[uri.replace(/#$/, "")] ?? "draft-07";
}

/** Compile `schema` under its declared dialect. Throws when it does not compile. */
export function compileJsonSchema(schema: Record<string, unknown>): ValidateFunction {
  return ajvFor(dialectOf(schema)).compile(schema);
}
