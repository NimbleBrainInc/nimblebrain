export interface AutomationSummary {
  id: string;
  name: string;
  description?: string;
  schedule: string;
  enabled: boolean;
  source: string;
  runCount: number;
  lastRunStatus: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  consecutiveErrors?: number;
  disabledAt?: string | null;
  disabledReason?: string | null;
  estimatedCostPerDay?: number;
}

export interface AutomationDetail {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  schedule: Record<string, unknown>;
  scheduleHuman: string;
  enabled: boolean;
  source: "user" | "agent" | "bundle";
  model?: string | null;
  maxIterations?: number;
  maxInputTokens?: number;
  allowedTools?: string[];
  skill?: string;
  runCount: number;
  consecutiveErrors: number;
  lastRunStatus: string | null;
  lastRunAt: string | null;
  lastRunAtHuman: string | null;
  nextRunAt: string | null;
  nextRunAtHuman: string | null;
  createdAt: string;
  updatedAt: string;
  disabledAt?: string | null;
  disabledReason?: string | null;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  tokenBudget?: { maxInputTokens?: number; maxOutputTokens?: number; period?: string } | null;
  budgetResetAt?: string | null;
  actualCostUsd?: number;
  estimatedCostPerRun?: number;
  estimatedCostPerDay?: number;
  estimatedCostPerMonth?: number;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  resultPreview?: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
  iterations?: number;
  stopReason?: "complete" | "max_iterations" | "length" | "content_filter" | "error" | "other";
}

/** One tool call from a run's activity log (mirror of the runtime's RunToolCall). */
export interface RunToolCall {
  id: string;
  name: string;
  input: unknown;
  output: string;
  ok: boolean;
  ms: number;
}

/** A file the run produced, resolvable in the workspace file store. */
export interface RunFileRef {
  id: string;
  filename: string;
}

/** The full result of a run — fetched on demand via the `run_result` action. */
export interface AutomationRunResult {
  runId: string;
  automationId: string;
  completedAt: string;
  output: string;
  activityLog: RunToolCall[];
  outputFiles: RunFileRef[];
  usage: { inputTokens: number; outputTokens: number; iterations: number };
  stopReason?: "complete" | "max_iterations" | "length" | "content_filter" | "error" | "other";
}
