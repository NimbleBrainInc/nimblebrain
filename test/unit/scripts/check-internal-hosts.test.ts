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

describe("check-internal-hosts — company-subdomain", () => {
  test("flags a non-public subdomain", () => {
    expect(rules(`host = "acme.${COMPANY_DOMAIN}"`)).toEqual(["company-subdomain"]);
  });

  test("flags a multi-label subdomain whose first label is public", () => {
    expect(rules(`https://docs.acme.env.${COMPANY_DOMAIN}/v1`)).toEqual(["company-subdomain"]);
  });

  test("flags a template whose literal part is a non-public subdomain", () => {
    expect(rules(`\`\${tenant}.acme.${COMPANY_DOMAIN}\``)).toEqual(["company-subdomain"]);
  });

  test("reports line and column", () => {
    const [f] = findInternalHosts(`ok\n  x.${COMPANY_DOMAIN}`);
    expect(f).toMatchObject({ line: 2, column: 3 });
  });

  test("does not flag public sites, the bare domain, or fictional hosts", () => {
    expect(rules(`https://static.${COMPANY_DOMAIN}/icons/x.png DOCS.${COMPANY_DOMAIN}`)).toEqual(
      [],
    );
    expect(rules(`mail someone@${COMPANY_DOMAIN} or visit ${COMPANY_DOMAIN}`)).toEqual([]);
    expect(rules("acme.nb.example.com nb.example.com")).toEqual([]);
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
