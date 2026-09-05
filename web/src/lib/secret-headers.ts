import type { DirectoryEntry, SecretHeaderRef } from "../api/client";

/**
 * A `secretHeaders` declaration, turned into something a person can be asked.
 *
 * The declaration is `{ "X-Db-Url": { ref: "credential", key: "acme.db_url" } }`
 * — a header name and a store key, neither of which is a label. `label` here is
 * the entry's own when it set one and a derivation from the key otherwise;
 * `header` is carried only so the dialog can be keyed and the UI can say which
 * connection field a value is for.
 */
export interface SecretHeaderField {
  /** Outgoing header the value is bound to. Display + React key only. */
  header: string;
  /** Credential-store key the value is written to. */
  key: string;
  /** What to call the value in the dialog. */
  label: string;
  /** One line of guidance from the entry, when it declared one. */
  help?: string;
}

/**
 * Words whose title-cased form reads wrong, and what to render instead.
 *
 * This is deliberately tiny and deliberately not extended on demand. Its whole
 * job is to keep the DERIVED default from looking like a variable name in a
 * dialog a person is answering — `Db Url` is worse than no label at all. A
 * connector that wants a real label declares `label` on the reference, which is
 * always better than anything guessed from an identifier.
 */
const WORD_FORMS: Record<string, string> = {
  api: "API",
  db: "Database",
  dsn: "DSN",
  id: "ID",
  ip: "IP",
  ssl: "SSL",
  tls: "TLS",
  uri: "URI",
  url: "URL",
};

/**
 * A readable default for a credential key: its last dotted segment, split on
 * word separators and title-cased — `acme.db_url` → "Database URL".
 *
 * The last segment because the leading ones namespace the key to a connector
 * ("acme"), which the dialog already says in its title. Returns the segment
 * verbatim when it holds nothing to split on, which is the honest outcome — an
 * opaque key gets an opaque label rather than invented prose.
 */
export function labelForCredentialKey(key: string): string {
  const segment = key.split(".").pop() ?? key;
  const words = segment.split(/[_\-\s]+/).filter((w) => w.length > 0);
  if (words.length === 0) return key;
  return words
    .map((w) => {
      const form = WORD_FORMS[w.toLowerCase()];
      if (form) return form;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/** Structural check — a declaration value that is a real credential reference. */
function isSecretHeaderRef(value: unknown): value is SecretHeaderRef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ref?: unknown }).ref === "credential" &&
    typeof (value as { key?: unknown }).key === "string"
  );
}

/**
 * The values a user must supply before this entry can connect.
 *
 * Only well-formed references are returned. A catalog entry that wrote a
 * literal where a reference belongs is miscurated and the server refuses to
 * install it, naming the header — so there is nothing to ask a user for, and
 * prompting them would collect a value against a key that does not exist. The
 * install then fails with the operator-facing message, which is the right
 * reader for that problem.
 *
 * Order follows the declaration, so the dialog's fields sit in the order the
 * operator wrote them.
 */
export function secretHeaderFields(install: DirectoryEntry["install"]): SecretHeaderField[] {
  // Gated on `auth` as well as `kind`. The projection carries `secretHeaders`
  // through for every auth kind and no catalog check rejects it, but only the
  // `provider` branch of the install ever wires the header — so on any other
  // kind the field is declared, ignored, and (without this) would have produced
  // a badge, a dialog, and a stored secret nothing goes on to send.
  if (install.kind !== "remote-oauth" || install.auth !== "provider") return [];
  return secretHeaderFieldsFrom(install.secretHeaders);
}

/**
 * The same derivation from a bare declaration — what the Configure page has,
 * since an installed connector carries its catalog entry rather than a
 * directory row.
 */
export function secretHeaderFieldsFrom(
  secretHeaders: Record<string, SecretHeaderRef> | undefined,
): SecretHeaderField[] {
  if (!secretHeaders) return [];
  const fields: SecretHeaderField[] = [];
  for (const [header, ref] of Object.entries(secretHeaders)) {
    if (!isSecretHeaderRef(ref)) continue;
    fields.push({
      header,
      key: ref.key,
      label: ref.label?.trim() || labelForCredentialKey(ref.key),
      ...(ref.help ? { help: ref.help } : {}),
    });
  }
  return fields;
}
