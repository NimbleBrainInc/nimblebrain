/**
 * Shared tool schema definitions for automations.
 * Used by both the standalone MCP server (server.ts) and the InlineSource (automations.ts).
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

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "create",
    description:
      "Create a new scheduled automation. Generates a kebab-case id from the name. Idempotent: if an automation with the same id already exists, returns the existing one.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Human-readable name for the automation.",
        },
        prompt: {
          type: "string",
          description: "The message sent to POST /v1/chat on each run.",
        },
        schedule: {
          type: "object",
          description: 'Schedule specification. Type "cron" or "interval".',
          properties: {
            type: { type: "string", enum: ["cron", "interval"] },
            expression: {
              type: "string",
              description: "5-field cron expression (when type=cron).",
            },
            timezone: { type: "string", description: "IANA timezone. Default: system timezone." },
            intervalMs: {
              type: "number",
              description: "Interval in ms (when type=interval). Min: 60000.",
            },
          },
          required: ["type"],
        },
        description: { type: "string", description: "What this automation does." },
        skill: { type: "string", description: "Force a specific skill match." },
        allowedTools: {
          type: "array",
          items: { type: "string" },
          description: "Tool allowlist (glob patterns).",
        },
        maxIterations: {
          type: "number",
          description: "Max iterations per run. Default: 5, hard cap: 15.",
        },
        maxInputTokens: {
          type: "number",
          description: "Max input tokens per run. Default: 200000.",
        },
        model: { type: "string", description: "Model override (null = workspace default)." },
        maxRunDurationMs: {
          type: "number",
          description: "Max execution time per run in ms. Default: 120000 (2 minutes).",
        },
        tokenBudget: {
          type: "object",
          description: "Optional token budget. Auto-disables when exceeded.",
          properties: {
            maxInputTokens: { type: "number", description: "Max cumulative input tokens." },
            maxOutputTokens: { type: "number", description: "Max cumulative output tokens." },
            period: {
              type: "string",
              enum: ["daily", "monthly"],
              description: "Budget reset period.",
            },
          },
        },
        enabled: { type: "boolean", description: "Whether active. Default: true." },
        source: {
          type: "string",
          enum: ["user", "agent", "bundle"],
          description: 'Who created this. Default: "agent".',
        },
        bundleName: { type: "string", description: "If bundle-contributed, which bundle." },
      },
      required: ["name", "prompt", "schedule"],
    },
  },
  {
    name: "update",
    description:
      "Update an existing automation by name. Applies partial updates to editable fields.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name of the automation to update." },
        description: { type: "string" },
        prompt: { type: "string" },
        schedule: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["cron", "interval"] },
            expression: { type: "string" },
            timezone: { type: "string" },
            intervalMs: { type: "number" },
          },
          required: ["type"],
        },
        skill: { type: "string" },
        allowedTools: { type: "array", items: { type: "string" } },
        maxIterations: { type: "number" },
        maxInputTokens: { type: "number" },
        model: { type: "string" },
        maxRunDurationMs: { type: "number" },
        tokenBudget: {
          type: "object",
          properties: {
            maxInputTokens: { type: "number" },
            maxOutputTokens: { type: "number" },
            period: { type: "string", enum: ["daily", "monthly"] },
          },
        },
        enabled: { type: "boolean" },
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
