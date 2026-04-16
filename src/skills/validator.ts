import type { SkillManifest } from "./types.ts";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const RESERVED_NAMES = ["soul", "bootstrap", "capabilities", "skill-authoring"];

const OVERRIDE_PATTERNS = [
  "ignore previous instructions",
  "you are now",
  "forget everything",
  "disregard all",
];

const VALID_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export function validateSkill(
  name: string,
  manifest: Partial<SkillManifest>,
  body: string,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate name is a valid filename
  if (!VALID_NAME_RE.test(name)) {
    errors.push("Skill name must contain only alphanumeric characters, hyphens, and underscores");
  }

  // Check reserved names
  if (RESERVED_NAMES.includes(name)) {
    errors.push(`Name '${name}' is reserved for core skills`);
  }

  // Validate priority range
  if (manifest.priority !== undefined) {
    if (manifest.priority < 11 || manifest.priority > 99) {
      errors.push("Priority must be between 11 and 99 (0-10 reserved for core skills)");
    }
  }

  // Check body for override patterns (case-insensitive substring)
  const bodyLower = body.toLowerCase();
  for (const pattern of OVERRIDE_PATTERNS) {
    if (bodyLower.includes(pattern)) {
      errors.push(`Skill body contains disallowed override pattern: '${pattern}'`);
    }
  }

  // Warn on wildcard tool access
  if (
    manifest.allowedTools &&
    manifest.allowedTools.length === 1 &&
    manifest.allowedTools[0] === "*"
  ) {
    warnings.push("Wildcard tool access ('*') bypasses tiered surfacing");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
