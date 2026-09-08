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
 * Scope: backticked references in Markdown files directly under
 * `src/skills/core/`. Tool contracts come from TypeScript files under
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

const MARKDOWN_REFERENCE_SPAN_RE = /`([^`]+)`/g;
const TOOL_REF_RE = /\b([a-z][a-z0-9-]*)__([a-z][a-z0-9_-]*|\*)(?![a-z0-9_-])/g;
const SCOPE_REF_RE = /\bscope:\s*"([^"]+)"/g;
const EXAMPLE_PREFIX_RE = /(?:\be\.g\.|\bfor example)[,:]?\s*$/i;

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
  const tools: LocatedReference[] = [];
  const scopes: Array<{ token: string; value: string; index: number }> = [];

  for (const span of line.matchAll(MARKDOWN_REFERENCE_SPAN_RE)) {
    const text = span[1] ?? "";
    const spanIndex = span.index ?? 0;
    const start = spanIndex + 1;
    const allowUnknownSource = EXAMPLE_PREFIX_RE.test(line.slice(0, spanIndex));
    tools.push(...toolReferences(text, start, allowUnknownSource));
    for (const match of text.matchAll(SCOPE_REF_RE)) {
      scopes.push({
        token: match[0],
        value: match[1] ?? "",
        index: start + (match.index ?? 0),
      });
    }
  }

  // A scope may be backticked next to a bold tool heading. Use all tool-shaped
  // text on that line to find the owner, while only backticked spans above are
  // themselves part of the checked prompt surface.
  return { tools, ownerTools: toolReferences(line, 0), scopes };
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

function owningTool(
  refs: LocatedReference[],
  scopeIndex: number,
  contracts: Map<string, ToolContract>,
): ToolContract | null {
  const concrete = refs.filter(
    (ref) => ref.name !== "*" && contracts.has(`${ref.source}__${ref.name}`),
  );
  const preceding = concrete.filter((ref) => ref.index <= scopeIndex);
  const ref = preceding.at(-1) ?? concrete[0];
  return ref ? (contracts.get(`${ref.source}__${ref.name}`) ?? null) : null;
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
): ReferenceViolation | null {
  const owner = owningTool(tools, scope.index, context.index);
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

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const { tools, ownerTools, scopes } = markdownReferences(lines[lineIndex] ?? "");
    context.line = lineIndex + 1;

    for (const ref of tools) {
      if (isGenericPlaceholder(ref)) continue;
      references.add(ref.token);
      const violation = validateToolReference(ref, context);
      if (violation) violations.push(violation);
    }

    for (const scope of scopes) {
      references.add(scope.token);
      const violation = validateScopeReference(scope, ownerTools, context);
      if (violation) violations.push(violation);
    }
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
