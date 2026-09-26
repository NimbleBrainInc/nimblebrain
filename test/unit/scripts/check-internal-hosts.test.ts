/**
 * Self-tests for `scripts/check-internal-hosts.ts`.
 *
 * Exercises the exported `findInternalHosts` directly on in-memory text. The
 * values the check must flag are assembled from fragments, so this file never
 * contains one literally and the check stays clean over its own test.
 */

import { describe, expect, test } from "bun:test";
import { findInternalHosts } from "../../../scripts/check-internal-hosts.ts";

const COMPANY_DOMAIN = ["nimblebrain", "ai"].join(".");
const AUTHKIT = ["authkit", "app"].join(".");
const CLIENT_PREFIX = ["client", "01"].join("_");

function rules(text: string): string[] {
  return findInternalHosts(text).map((f) => f.rule);
}

describe("check-internal-hosts — internal-platform-host", () => {
  test("flags a tenant platform host", () => {
    expect(rules(`host = "acme.platform.${COMPANY_DOMAIN}"`)).toEqual(["internal-platform-host"]);
  });

  test("flags a platform host with an environment label", () => {
    expect(rules(`https://acme.platform.preview.${COMPANY_DOMAIN}/v1`)).toEqual([
      "internal-platform-host",
    ]);
  });

  test("reports line and column", () => {
    const [f] = findInternalHosts(`ok\n  x.platform.${COMPANY_DOMAIN}`);
    expect(f).toMatchObject({ line: 2, column: 5 });
  });

  test("does not flag fictional or public hosts", () => {
    expect(rules("acme.nb.example.com nb.example.com")).toEqual([]);
    expect(rules(`https://static.${COMPANY_DOMAIN}/icons/x.png`)).toEqual([]);
  });
});

describe("check-internal-hosts — authkit-subdomain", () => {
  test("flags a subdomain outside the allow-list", () => {
    expect(rules(`https://acme-prod.${AUTHKIT}/oauth2/jwks`)).toEqual(["authkit-subdomain"]);
  });

  test("allows the fictional subdomains, case-insensitively", () => {
    expect(rules(`https://testapp.${AUTHKIT} MyApp.${AUTHKIT}`)).toEqual([]);
  });

  test("does not flag a template that builds the host", () => {
    expect(rules(`\`https://\${this.authkitDomain}.${AUTHKIT}\``)).toEqual([]);
  });
});

describe("check-internal-hosts — workos-client-id", () => {
  test("flags the WorkOS client-id shape", () => {
    expect(rules(`clientId: "${CLIENT_PREFIX}${"7".repeat(24)}"`)).toEqual(["workos-client-id"]);
  });

  test("does not flag placeholder ids that break the shape", () => {
    expect(rules(`"client_test" "${CLIENT_PREFIX}ABC..."`)).toEqual([]);
  });
});
