import { describe, expect, test } from "bun:test";
import {
  RESERVED_AUTHORIZE_PARAMS,
  validateAdditionalAuthorizationParams,
} from "../../src/util/oauth-params.ts";

describe("validateAdditionalAuthorizationParams", () => {
  test("no-op for undefined", () => {
    expect(() => validateAdditionalAuthorizationParams(undefined)).not.toThrow();
  });

  test("no-op for empty map", () => {
    expect(() => validateAdditionalAuthorizationParams({})).not.toThrow();
  });

  test("allows non-reserved keys", () => {
    expect(() =>
      validateAdditionalAuthorizationParams({ access_type: "offline", prompt: "consent" }),
    ).not.toThrow();
  });

  test("throws on each reserved key", () => {
    for (const key of RESERVED_AUTHORIZE_PARAMS) {
      expect(() => validateAdditionalAuthorizationParams({ [key]: "x" })).toThrow(
        /reserved keys/,
      );
    }
  });

  test("throws on OIDC hijack vectors", () => {
    for (const key of ["request", "request_uri", "response_mode"]) {
      expect(() => validateAdditionalAuthorizationParams({ [key]: "x" })).toThrow();
    }
  });

  test("error message names every offending key", () => {
    expect(() =>
      validateAdditionalAuthorizationParams({ client_id: "a", state: "b", access_type: "c" }),
    ).toThrow(/client_id, state/);
  });
});
