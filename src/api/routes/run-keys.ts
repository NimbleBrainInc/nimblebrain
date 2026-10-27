import { Hono } from "hono";
import { RUN_KEY_SET_PATH } from "../../runtime/run-key.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import type { RunKeySetResponse, WellKnownErrorBody } from "../schemas/responses.ts";
import { json } from "../types.ts";

/**
 * `GET /.well-known/run-keys.json`: the public halves of the installation's
 * run key (ADR-0057), so the model gateway verifies a turn's credential
 * against the runtime's own server and holds no copy of the key.
 *
 * A route rather than a tool action because its caller is a gateway, not a
 * signed-in person: it fetches a key set by URL with no credential, as any
 * JWT verifier does, before it can check anything. It is unauthenticated and
 * cacheable for that reason, and nothing in it is private. The cache is short
 * because a rotation publishes a new key and waits out this cache before the
 * key signs anything.
 *
 * An installation with no run key answers 404: it mints nothing, so there is
 * nothing to verify.
 */
export function runKeyRoutes(runtime: Pick<Runtime, "getRunKey">) {
  return new Hono().get(RUN_KEY_SET_PATH, () => {
    const runKey = runtime.getRunKey();
    if (!runKey) {
      return json<WellKnownErrorBody>(
        { error: "not_found", message: "This installation has no run key." },
        404,
      );
    }
    return json<RunKeySetResponse>(runKey.keySet(), 200, {
      "Cache-Control": "public, max-age=300",
    });
  });
}
