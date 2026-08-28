/**
 * The `<source>__<tool>` grammar — the single decomposition site.
 *
 * A wire tool name is `<source>__<tool>`: the `<source>` segment is the key a
 * `ToolRegistry` (or an identity source, or a personal connector) is registered
 * under, and `<tool>` is the bare name that source's `execute` takes. Every
 * dispatch door has to take a name apart the same way, or two doors answer the
 * same question differently and the divergence is a misroute.
 *
 * **Why `src/util/` and not `src/tools/`.** Both `src/tools/` and `src/runtime/`
 * need this, and `check:cycles` forbids `src/runtime/**` from importing
 * `src/tools/**` (only the composition roots are exempt). `src/util/` is the
 * layer both may import — the same reason `util/concurrency.ts` exists, and the
 * arrangement `scripts/check-cycles.ts` names in its own rationale. A home under
 * `src/tools/` does not admit one shared definition: it forces `src/runtime/` to
 * carry its own copy, which is the drift this module exists to remove.
 *
 * Distinct from `src/tools/namespace.ts`, which owns a *different* grammar: the
 * retired `ws_<id>-<toolName>` workspace prefix. That one is about which
 * workspace a name addresses; this one is about which source inside a workspace.
 *
 * Split on the FIRST `__`. Safe because `slugifyServerName` emits `[a-z0-9-]`
 * and never `_`, so a source segment cannot itself contain `__`; a tool segment
 * may (`a__b__c` is source `a`, tool `b__c`).
 */

/**
 * Decompose `<source>__<tool>` into its parts.
 *
 * `hasSeparator` is the third fact, and it is why this returns a record rather
 * than two strings: "this name has no source segment" is a distinct answer, and
 * a caller that re-derives it from a segment's value gets it wrong — `x__x` has
 * equal segments AND a separator, `plain` has equal segments and none. Read the
 * flag. Leaving it out is what makes each call site invent its own sentinel for
 * absence, and two sentinels that disagree are two doors that route differently.
 *
 * With no separator both segments are the whole input, so a caller that only
 * needs a best-effort source label can ignore the flag and still get a usable
 * one.
 */
export function splitInnerToolName(innerName: string): {
  sourcePrefix: string;
  bareToolName: string;
  hasSeparator: boolean;
} {
  const sepIndex = innerName.indexOf("__");
  if (sepIndex < 0) {
    return { sourcePrefix: innerName, bareToolName: innerName, hasSeparator: false };
  }
  return {
    sourcePrefix: innerName.slice(0, sepIndex),
    bareToolName: innerName.slice(sepIndex + 2),
    hasSeparator: true,
  };
}
