---
name: automation-authoring
description: Teaches the agent how to create and manage scheduled automations
type: context
priority: 16
---

# Automation Management

When the user asks you to schedule, automate, or set up recurring tasks, use
the automations tools. All operations go through `automations__*` tools.

## Tool Reference

| Tool | Use for |
|------|---------|
| `automations__create` | Create a new automation |
| `automations__update` | Change schedule, prompt, enable/disable |
| `automations__delete` | Remove an automation |
| `automations__list` | Show all automations |
| `automations__status` | Detailed status + run history for one automation |
| `automations__runs` | Query run history across automations |
| `automations__run` | Trigger immediate execution |
| `automations__cancel` | Cancel an in-flight run |

## Converting Natural Language to Cron

Common patterns:
- "every morning at 8am" → "0 8 * * *"
- "every hour" → "0 * * * *"
- "every 30 minutes" → interval type, intervalMs: 1800000
- "weekly on Mondays" → "0 9 * * 1" (default 9am if no time)
- "daily" → "0 9 * * *" (default 9am if no time)
- "every weekday" → "0 9 * * 1-5"

When no timezone is specified, use the workspace timezone.

## Writing Good Prompts

Write the prompt as if the user typed it:
- Be specific about what to check and how to summarize
- Include output expectations
- Reference tools by name if the automation needs specific capabilities

Automations can chain multiple tools across different apps in a single run.
For example: "Run the pipeline report, generate a PDF, and add a TODO" will
use tools from reports, typst, and todo bundles in sequence.

## Before Creating — Tool Validation

Before proposing an automation, verify the tools it needs actually exist:

1. Identify the key tools/capabilities the prompt requires
2. Call `nb__search` with `scope: "tools"` and relevant keywords to confirm they're available
3. If no matching tools found, warn the user: "The tools needed for this
   automation don't appear to be installed. Consider installing [bundle] first."

Do not create automations that reference tools that don't exist — they will
burn tokens failing on every run.

## Before Creating

Always show the user:
1. The automation name and schedule in human-readable form
2. The prompt that will be sent
3. Any tool restrictions
4. Ask for confirmation
5. Offer a test run: "Want me to run this once first to verify it works?"

After creation, tell the user when the next run will be.

## Token Budget Guidance

Each run consumes tokens. A 30-minute automation with default settings uses
~20K input tokens per run, which is ~960 runs/month.

Suggest token budgets based on frequency:
- Automations running **more than 4x/day**: suggest a daily token budget
  (e.g., `tokenBudget: { maxInputTokens: 500000, period: "daily" }`)
- Automations running **weekly or less**: suggest a monthly budget
  (e.g., `tokenBudget: { maxInputTokens: 2000000, period: "monthly" }`)
- For expensive models (Opus), always suggest a budget

The `maxRunDurationMs` field defaults to 120 seconds. Increase it for complex
multi-tool tasks that may take longer (max: 600 seconds / 10 minutes).

## Checking Status

Use automations__status for read queries.
When an automation fails, offer to show the conversation, adjust the prompt,
or increase the iteration limit. If consecutive errors are mounting, suggest
reviewing the failure pattern.

If an automation was auto-disabled (check `disabledReason` in status), explain
why and offer to fix the root cause before re-enabling.
