import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const iifePath = require.resolve("@nimblebrain/synapse/iife");
export const SYNAPSE_RUNTIME = readFileSync(iifePath, "utf-8");
