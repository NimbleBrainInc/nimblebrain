/**
 * Shared tool schema definitions for automations.
 * Used by both the standalone MCP server (server.ts) and the in-process
 * platform source (src/tools/platform/automations.ts).
 *
 * Shape convention (per src/tools/platform/types.ts SCHEMA_PRINCIPLES):
 *
 *   create: { manifest: { ...config }, body: <prompt> }
 *   update: { name, manifest?: Partial<config>, body?: <new prompt> }
 *
 * `manifest` is the persistent automation definition; `body` is the prompt
 * sent to POST /v1/chat on each run — the analog of a skill's markdown
 * body. Operator-only fields (`source`, `bundleName`) are not in the
 * LLM-facing schema; they live on the stored type and are set by the
 * runtime, never by an authoring caller.
 */

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ── Shared sub-schemas ───────────────────────────────────────────────────

const SCHEDULE_SCHEMA = {
  type: "object" as const,
  properties: {
    type: { type: "string" as const, enum: ["cron", "interval"] },
    expression: {
      type: "string" as const,
      description: "5-field cron expression (when type=cron).",
    },
    timezone: {
      type: "string" as const,
      description: "IANA timezone. Default: system timezone.",
    },
    intervalMs: {
      type: "number" as const,
      minimum: 60000,
      description: "Interval in ms (when type=interval). Min 60000.",
    },
  },
  required: ["type"],
};

const TOKEN_BUDGET_SCHEMA = {
  type: "object" as const,
  properties: {
    maxInputTokens: { type: "number" as const },
    maxOutputTokens: { type: "number" as const },
    period: { type: "string" as const, enum: ["daily", "monthly"] },
  },
};

/**
 * Manifest properties — used by both create (with required: [name,
 * schedule]) and update (no required, all optional patch).
 */
const AUTOMATION_MANIFEST_PROPERTIES = {
  name: {
    type: "string" as const,
    description: "Human-readable name. Becomes the kebab-case id.",
  },
  description: {
    type: "string" as const,
    description: "What this automation does.",
  },
  schedule: SCHEDULE_SCHEMA,
  enabled: {
    type: "boolean" as const,
    description: "Whether the automation runs. Default true.",
  },
  skill: {
    type: "string" as const,
    description: "Force a specific skill match for this automation's runs.",
  },
  model: {
    type: "string" as const,
    description: "Model override. Omit to use the workspace default.",
  },
  maxIterations: {
    type: "number" as const,
    description: "Max LLM iterations per run. Default 5, hard cap 15.",
  },
  maxInputTokens: {
    type: "number" as const,
    description: "Max input tokens per run. Default 200000.",
  },
  maxRunDurationMs: {
    type: "number" as const,
    description: "Max wall-clock per run (ms). Default 120000.",
  },
  tokenBudget: TOKEN_BUDGET_SCHEMA,
};

// ── Tool schemas ─────────────────────────────────────────────────────────

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "create",
    description:
      "Create a scheduled automation. `manifest` is the config; `body` is the prompt sent " +
      "to POST /v1/chat on each run. Generates a kebab-case id from `manifest.name`. " +
      "Idempotent: returns the existing automation if one with the same id exists.",
    inputSchema: {
      type: "object" as const,
      properties: {
        manifest: {
          type: "object",
          properties: AUTOMATION_MANIFEST_PROPERTIES,
          required: ["name", "schedule"],
          description: "Automation definition: identity, schedule, run-time policy.",
        },
        body: {
          type: "string",
          description: "The prompt sent on each scheduled run.",
        },
      },
      required: ["manifest", "body"],
    },
  },
  {
    name: "update",
    description:
      "Update an existing automation by name. Provide a partial `manifest` patch and/or a new " +
      "`body` (prompt). Omitted fields keep their current values.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name of the automation to update." },
        manifest: {
          type: "object",
          properties: AUTOMATION_MANIFEST_PROPERTIES,
          description: "Partial manifest patch. Omitted fields keep their current values.",
        },
        body: {
          type: "string",
          description: "New prompt. Omit to keep the current prompt.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "delete",
    description: "Delete an automation by name. Removes the definition but preserves run history.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name of the automation to delete." },
      },
      required: ["name"],
    },
  },
  {
    name: "list",
    description:
      "List automations with optional filters. Returns summary with human-readable schedule strings and relative times.",
    inputSchema: {
      type: "object" as const,
      properties: {
        enabled: { type: "boolean", description: "Filter by enabled status." },
        source: {
          type: "string",
          enum: ["user", "agent", "bundle"],
          description: "Filter by source.",
        },
      },
    },
  },
  {
    name: "status",
    description: "Get full status of a single automation by name, including recent run history.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name of the automation." },
        limit: { type: "number", description: "Max recent runs to include. Default: 5." },
      },
      required: ["name"],
    },
  },
  {
    name: "runs",
    description: "Query run history across automations with filters.",
    inputSchema: {
      type: "object" as const,
      properties: {
        automationId: { type: "string", description: "Filter by automation ID." },
        status: {
          type: "string",
          enum: ["running", "success", "failure", "timeout", "cancelled", "skipped"],
          description: "Filter by run status.",
        },
        since: {
          type: "string",
          description: "ISO timestamp — only runs started on or after this time.",
        },
        limit: { type: "number", description: "Max runs to return. Default: 20." },
      },
    },
  },
  {
    name: "run",
    description:
      "Trigger an immediate execution of an automation, bypassing schedule and backoff. Waits for completion and returns the run result.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name of the automation to run." },
      },
      required: ["name"],
    },
  },
  {
    name: "cancel",
    description:
      "Cancel an in-flight automation run. Returns whether a run was actually cancelled.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name of the automation to cancel." },
      },
      required: ["name"],
    },
  },
];
