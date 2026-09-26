/**
 * The MCP Skills Extension (SEP-2640, `io.modelcontextprotocol/skills`), client side.
 *
 * A server that declares the extension in `capabilities.extensions` answers
 * `skills/list` with one entry per skill: the `SKILL.md` URI, its frontmatter
 * verbatim as JSON, and a manifest of the skill's files with a SHA-256 digest
 * and byte size each (or `"dynamic"` when content is generated). The listing is
 * the authoritative record of what is a skill; the files themselves are read
 * with ordinary `resources/read`.
 *
 * This module holds the wire shape and the two host-side checks the extension
 * requires before a fetched `SKILL.md` may be used: the bytes match the listed
 * digest and size, and the fetched frontmatter equals the listed frontmatter.
 * It does no I/O; `McpSource.listSkills` issues the request and the runtime
 * applies these checks to what it reads.
 */

import { createHash } from "node:crypto";
import matter from "gray-matter";
import { z } from "zod";

/** Extension identifier, the key in `capabilities.extensions` on both sides of the handshake. */
export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills" as const;

/** The enumeration method every server declaring the extension implements. */
export const SKILLS_LIST_METHOD = "skills/list" as const;

/**
 * The client's declaration. An empty object claims the extension with no
 * optional settings; `directoryRead` is a server-side setting and has no
 * client counterpart.
 */
export function skillsClientExtension(): Record<string, object> {
  return { [SKILLS_EXTENSION_ID]: {} };
}

/**
 * One page of a `skills/list` result. Entries are validated one at a time by
 * {@link parseSkillEntry}, so one malformed entry drops that skill rather than
 * the page.
 */
export const SkillsListResultSchema = z.looseObject({
  skills: z.array(z.unknown()),
  nextCursor: z.string().optional(),
});

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

const SkillFileSchema = z.object({
  uri: z.string().min(1),
  digest: z.string().regex(SHA256_DIGEST_RE),
  size: z.number().int().nonnegative(),
});

const SkillEntrySchema = z.object({
  uri: z.string().regex(/\/SKILL\.md$/),
  frontmatter: z.looseObject({ name: z.string().min(1), description: z.string() }),
  resources: z.union([z.array(SkillFileSchema), z.literal("dynamic")]),
});

/** A skill entry from `skills/list`: the `SKILL.md` URI, its frontmatter, and its file manifest. */
export type SkillEntry = z.infer<typeof SkillEntrySchema>;

/**
 * Validate one listing entry, or `null` when the host must not load it.
 *
 * Invalid per the extension: a missing `resources`, or one that is neither an
 * array nor `"dynamic"`; a `uri` that is not a `SKILL.md`; frontmatter without
 * `name` and `description`; and a `uri` whose final skill-path segment is not
 * `frontmatter.name`, since the name must be recoverable from the URI alone.
 */
export function parseSkillEntry(raw: unknown): SkillEntry | null {
  const parsed = SkillEntrySchema.safeParse(raw);
  if (!parsed.success) return null;
  const entry = parsed.data;
  const segments = entry.uri.replace(/\/SKILL\.md$/, "").split("/");
  if (segments[segments.length - 1] !== entry.frontmatter.name) return null;
  return entry;
}

/** Why a fetched `SKILL.md` failed verification against its entry. */
export type SkillVerificationFailure =
  | "unlisted"
  | "size_mismatch"
  | "digest_mismatch"
  | "frontmatter_mismatch";

/**
 * Check a fetched `SKILL.md` against the entry it was listed under.
 *
 * With a manifest, the entry's own file must be listed, and the fetched bytes
 * must match its `size` and `digest`. With `"dynamic"` there is nothing to
 * hash, so only the frontmatter check applies. In both cases the frontmatter
 * parsed from the fetched file must equal the listed `frontmatter` field for
 * field. Any failure means the content is not what the listing described, and
 * the extension forbids using it.
 */
export function verifySkillEntrypoint(
  entry: SkillEntry,
  text: string,
): { ok: true } | { ok: false; reason: SkillVerificationFailure } {
  if (entry.resources !== "dynamic") {
    const listed = entry.resources.find((file) => file.uri === entry.uri);
    if (!listed) return { ok: false, reason: "unlisted" };
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength !== listed.size) return { ok: false, reason: "size_mismatch" };
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== listed.digest) return { ok: false, reason: "digest_mismatch" };
  }
  let fetched: unknown;
  try {
    fetched = matter(text).data;
  } catch {
    return { ok: false, reason: "frontmatter_mismatch" };
  }
  if (!frontmatterEqual(fetched, entry.frontmatter)) {
    return { ok: false, reason: "frontmatter_mismatch" };
  }
  return { ok: true };
}

/**
 * Field-by-field equality of frontmatter parsed from YAML against the listing's
 * JSON rendering of it. JSON has no date type, so a YAML timestamp the parser
 * turned into a `Date` equals a listed string naming the same instant
 * (`2026-01-01` or `2026-01-01T00:00:00.000Z`). Every other value compares
 * strictly.
 */
function frontmatterEqual(fetched: unknown, listed: unknown): boolean {
  if (fetched instanceof Date) {
    return typeof listed === "string" && new Date(listed).getTime() === fetched.getTime();
  }
  if (Array.isArray(fetched)) {
    return (
      Array.isArray(listed) &&
      listed.length === fetched.length &&
      fetched.every((value, i) => frontmatterEqual(value, listed[i]))
    );
  }
  if (fetched && typeof fetched === "object") {
    if (!listed || typeof listed !== "object" || Array.isArray(listed)) return false;
    const a = fetched as Record<string, unknown>;
    const b = listed as Record<string, unknown>;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && frontmatterEqual(a[key], b[key]))
    );
  }
  return fetched === listed;
}

/**
 * The URIs a host may read as files of this skill, or `null` for a
 * `"dynamic"` skill, which has no manifest to bound them.
 */
export function listedSkillFiles(entry: SkillEntry): string[] | null {
  return entry.resources === "dynamic" ? null : entry.resources.map((file) => file.uri);
}
