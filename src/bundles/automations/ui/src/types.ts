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
  conversationId?: string;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
  iterations?: number;
  stopReason?: "complete" | "max_iterations" | "length" | "content_filter" | "error" | "other";
}
