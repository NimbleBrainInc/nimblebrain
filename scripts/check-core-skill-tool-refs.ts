#!/usr/bin/env bun
/**
 * Lint: tool and scope references in shipped core skills must resolve against
 * the static tool contracts they describe.
 *
 * Core-skill Markdown can drift independently from the schemas AJV validates
 * before a handler runs. A stale tool name or scope therefore teaches the model
 * to make a call the platform itself rejects. This check keeps that prose and
 * the statically declared contracts in lockstep without constructing a runtime.
 *
 * Scope: backticked and bold-marked references in Markdown files directly
 * under `src/skills/core/`. Both shapes declare contracts in these prompts — a
 * bullet names its tool in bold and its arguments in backticks — so both are
 * checked. Tool contracts come from TypeScript files under
 * `src/tools/` (`nb__*`) and each platform app's `source.ts` / `schemas.ts`
 * declarations (`<source>__*`). Explicit examples for dynamically installed
 * connectors are syntax examples, so only their namespace shape is static.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import * as ts from "typescript";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const CORE_SKILLS_ROOT = join(ROOT, "src", "skills", "core");
const TOOLS_ROOT = join(ROOT, "src", "tools");
const PLATFORM_ROOT = join(ROOT, "src", "platform");

const MARKDOWN_REFERENCE_SPANS: Array<{ re: RegExp; delimiter: number }> = [
  { re: /`([^`]+)`/g, delimiter: 1 },
  { re: /\*\*([^*]+)\*\*/g, delimiter: 2 },
];
const TOOL_REF_RE = /\b([a-z][a-z0-9-]*)__([a-z][a-z0-9_-]*|\*)(?![a-z0-9_-])/g;
const SCOPE_REF_RE = /\bscope:\s*"([^"]+)"/g;
const EXAMPLE_PREFIX_RE = /(?:\be\.g\.|\bfor example)[,:]?\s*$/i;
const BLOCK_BREAK_RE = /^\s*(?:#|$)/;

export interface ToolContract {
  source: string;
  name: string;
  scopes: string[];
}

export interface ReferenceViolation {
  file: string;
  line: number;
  token: string;
  owner: string;
  accepted: string[];
}

export interface CoreSkillValidation {
  references: string[];
  violations: ReferenceViolation[];
}

function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(node)) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  return null;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyValue(object: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const property of object.properties) {
    if (propertyName(property) === name && ts.isPropertyAssignment(property)) {
      return unwrap(property.initializer);
    }
  }
  return null;
}

function stringValue(expression: ts.Expression | null): string | null {
  if (
    expression &&
    (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
  ) {
    return expression.text;
  }
  return null;
}

function scopeEnum(inputSchema: ts.Expression | null): string[] {
  if (!inputSchema || !ts.isObjectLiteralExpression(inputSchema)) return [];
  const properties = propertyValue(inputSchema, "properties");
  if (!properties || !ts.isObjectLiteralExpression(properties)) return [];
  const scope = propertyValue(properties, "scope");
  if (!scope || !ts.isObjectLiteralExpression(scope)) return [];
  const enumValue = propertyValue(scope, "enum");
  if (!enumValue || !ts.isArrayLiteralExpression(enumValue)) return [];

  return enumValue.elements
    .map((element) => stringValue(unwrap(element)))
    .filter((value): value is string => value !== null)
    .sort();
}

/** Extract static `{ name, inputSchema }` tool definitions from one TS file. */
export function extractToolContracts(source: string, code: string): ToolContract[] {
  const sourceFile = ts.createSourceFile(
    `${source}.ts`,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const contracts = new Map<string, ToolContract>();

  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      const name = stringValue(propertyValue(node, "name"));
      const inputSchema = propertyValue(node, "inputSchema");
      if (name && inputSchema) {
        const key = `${source}__${name}`;
        const previous = contracts.get(key);
        contracts.set(key, {
          source,
          name,
          scopes: [...new Set([...(previous?.scopes ?? []), ...scopeEnum(inputSchema)])].sort(),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...contracts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function contractIndex(contracts: ToolContract[]): Map<string, ToolContract> {
  const index = new Map<string, ToolContract>();
  for (const contract of contracts) {
    const key = `${contract.source}__${contract.name}`;
    const previous = index.get(key);
    index.set(key, {
      ...contract,
      scopes: [...new Set([...(previous?.scopes ?? []), ...contract.scopes])].sort(),
    });
  }
  return index;
}

interface LocatedReference {
  token: string;
  source: string;
  name: string;
  index: number;
  allowUnknownSource: boolean;
}

function toolReferences(
  text: string,
  start: number,
  allowUnknownSource = false,
): LocatedReference[] {
  return [...text.matchAll(TOOL_REF_RE)].map((match) => ({
    token: match[0],
    source: match[1] ?? "",
    name: match[2] ?? "",
    index: start + (match.index ?? 0),
    allowUnknownSource,
  }));
}

function isGenericPlaceholder(ref: LocatedReference): boolean {
  return ref.source === "source" && ref.name === "tool";
}

function markdownReferences(line: string): {
  tools: LocatedReference[];
  ownerTools: LocatedReference[];
  scopes: Array<{ token: string; value: string; index: number }>;
} {
  const tools = new Map<number, LocatedReference>();
  const scopes = new Map<number, { token: string; value: string; index: number }>();

  for (const { re, delimiter } of MARKDOWN_REFERENCE_SPANS) {
    for (const span of line.matchAll(re)) {
      const text = span[1] ?? "";
      const spanIndex = span.index ?? 0;
      const start = spanIndex + delimiter;
      const allowUnknownSource = EXAMPLE_PREFIX_RE.test(line.slice(0, spanIndex));
      for (const ref of toolReferences(text, start, allowUnknownSource)) {
        tools.set(ref.index, ref);
      }
      for (const match of text.matchAll(SCOPE_REF_RE)) {
        const index = start + (match.index ?? 0);
        scopes.set(index, { token: match[0], value: match[1] ?? "", index });
      }
    }
  }

  // A nested span (`**\`nb__search\`**`) matches under both shapes at the same
  // offset, so keying by offset keeps one reference per occurrence. Owner
  // resolution reads every tool-shaped token on the line, marked up or not.
  return {
    tools: [...tools.values()],
    ownerTools: toolReferences(line, 0),
    scopes: [...scopes.values()],
  };
}

function acceptedToolsBySource(contracts: ToolContract[]): Map<string, string[]> {
  const accepted = new Map<string, string[]>();
  for (const contract of contracts) {
    const names = accepted.get(contract.source) ?? [];
    if (!names.includes(contract.name)) names.push(contract.name);
    accepted.set(contract.source, names.sort());
  }
  return accepted;
}

interface DeclaredTool {
  index: number;
  contract: ToolContract;
}

function declaredTools(
  refs: LocatedReference[],
  contracts: Map<string, ToolContract>,
): DeclaredTool[] {
  return refs.flatMap((ref) => {
    const contract = ref.name === "*" ? undefined : contracts.get(`${ref.source}__${ref.name}`);
    return contract ? [{ index: ref.index, contract }] : [];
  });
}

/**
 * The tool a scope value belongs to: the nearest declaration before it on the
 * line, else the block's standing owner — a bullet hard-wrapped across several
 * lines still describes the tool it opened with — else one named later on the
 * line.
 */
function owningTool(
  refs: LocatedReference[],
  scopeIndex: number,
  contracts: Map<string, ToolContract>,
  blockOwner: ToolContract | null,
): ToolContract | null {
  const declared = declaredTools(refs, contracts);
  const preceding = declared.filter((tool) => tool.index <= scopeIndex);
  return preceding.at(-1)?.contract ?? blockOwner ?? declared[0]?.contract ?? null;
}

interface ValidationContext {
  file: string;
  line: number;
  contracts: ToolContract[];
  index: Map<string, ToolContract>;
  sources: Set<string>;
  acceptedBySource: Map<string, string[]>;
}

function validateToolReference(
  ref: LocatedReference,
  context: ValidationContext,
): ReferenceViolation | null {
  if (!context.sources.has(ref.source)) {
    if (ref.allowUnknownSource) return null;
    return {
      file: context.file,
      line: context.line,
      token: ref.token,
      owner: "static tool source",
      accepted: [...context.sources].sort(),
    };
  }
  if (ref.name === "*" || context.index.has(ref.token)) return null;
  return {
    file: context.file,
    line: context.line,
    token: ref.token,
    owner: ref.source,
    accepted: context.acceptedBySource.get(ref.source) ?? [],
  };
}

function validateScopeReference(
  scope: { token: string; value: string; index: number },
  tools: LocatedReference[],
  context: ValidationContext,
  blockOwner: ToolContract | null,
): ReferenceViolation | null {
  const owner = owningTool(tools, scope.index, context.index, blockOwner);
  if (!owner) {
    return {
      file: context.file,
      line: context.line,
      token: scope.token,
      owner: "unresolved tool",
      accepted: context.contracts
        .filter((contract) => contract.scopes.length > 0)
        .map((contract) => `${contract.source}__${contract.name}`)
        .sort(),
    };
  }
  if (owner.scopes.includes(scope.value)) return null;
  return {
    file: context.file,
    line: context.line,
    token: scope.token,
    owner: `${owner.source}__${owner.name}`,
    accepted: owner.scopes,
  };
}

interface LineValidation {
  references: string[];
  violations: ReferenceViolation[];
  /** The tool whose description continues onto the next line, if any. */
  blockOwner: ToolContract | null;
}

function validateMarkdownLine(
  line: string,
  context: ValidationContext,
  blockOwner: ToolContract | null,
): LineValidation {
  const { tools, ownerTools, scopes } = markdownReferences(line);
  const references: string[] = [];
  const violations: ReferenceViolation[] = [];

  for (const ref of tools) {
    if (isGenericPlaceholder(ref)) continue;
    references.push(ref.token);
    const violation = validateToolReference(ref, context);
    if (violation) violations.push(violation);
  }

  // A line naming no tool continues the previous line's subject; one naming a
  // tool that does not resolve starts a subject we cannot identify, so the
  // standing owner lapses rather than mis-attributing its scopes.
  const standingOwner: ToolContract | null = ownerTools.length === 0 ? blockOwner : null;

  for (const scope of scopes) {
    references.push(scope.token);
    const violation = validateScopeReference(scope, ownerTools, context, standingOwner);
    if (violation) violations.push(violation);
  }

  return {
    references,
    violations,
    blockOwner: BLOCK_BREAK_RE.test(line)
      ? null
      : (declaredTools(ownerTools, context.index).at(-1)?.contract ?? standingOwner),
  };
}

/** Validate one Markdown core skill against already-extracted contracts. */
export function validateCoreSkill(
  file: string,
  markdown: string,
  contracts: ToolContract[],
): CoreSkillValidation {
  const context: ValidationContext = {
    file,
    line: 0,
    contracts,
    index: contractIndex(contracts),
    sources: new Set(contracts.map((contract) => contract.source)),
    acceptedBySource: acceptedToolsBySource(contracts),
  };
  const references = new Set<string>();
  const violations: ReferenceViolation[] = [];
  const lines = markdown.split("\n");
  let blockOwner: ToolContract | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    context.line = lineIndex + 1;
    const line = validateMarkdownLine(lines[lineIndex] ?? "", context, blockOwner);
    for (const reference of line.references) references.add(reference);
    violations.push(...line.violations);
    blockOwner = line.blockOwner;
  }

  return { references: [...references].sort(), violations };
}

function loadContracts(): ToolContract[] {
  const contracts: ToolContract[] = [];

  for (const rel of new Glob("**/*.ts").scanSync({ cwd: TOOLS_ROOT })) {
    const file = join(TOOLS_ROOT, rel);
    contracts.push(...extractToolContracts("nb", readFileSync(file, "utf-8")));
  }

  for (const rel of new Glob("*/{source,schemas}.ts").scanSync({ cwd: PLATFORM_ROOT })) {
    const [source] = rel.split(/[\\/]/);
    if (!source) continue;
    const file = join(PLATFORM_ROOT, rel);
    contracts.push(...extractToolContracts(source, readFileSync(file, "utf-8")));
  }

  return [...contractIndex(contracts).values()].sort((a, b) => {
    const sourceOrder = a.source.localeCompare(b.source);
    return sourceOrder === 0 ? a.name.localeCompare(b.name) : sourceOrder;
  });
}

function main(): void {
  const contracts = loadContracts();
  const references = new Set<string>();
  const violations: ReferenceViolation[] = [];
  let scanned = 0;

  for (const rel of new Glob("*.md").scanSync({ cwd: CORE_SKILLS_ROOT })) {
    const file = join(CORE_SKILLS_ROOT, rel);
    const displayPath = relative(ROOT, file).split("\\").join("/");
    const result = validateCoreSkill(displayPath, readFileSync(file, "utf-8"), contracts);
    for (const reference of result.references) references.add(reference);
    violations.push(...result.violations);
    scanned++;
  }

  if (violations.length > 0) {
    console.error(`✗ Found ${violations.length} invalid core-skill tool/schema reference(s):\n`);
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line}  ${violation.token}`);
      console.error(`    owner: ${violation.owner}`);
      console.error(`    accepted: ${violation.accepted.join(", ") || "(none)"}\n`);
    }
    process.exit(1);
  }

  console.log(
    `✓ ${references.size} distinct tool/scope references validated across ${scanned} core skills`,
  );
}

if (import.meta.main) main();
