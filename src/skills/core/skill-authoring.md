---
name: skill-authoring
description: Teaches the agent how to create well-structured user skills
type: skill
priority: 50
metadata:
  triggers:
    - "create a skill"
    - "new skill"
    - "modify skill"
    - "manage skill"
    - "edit skill"
    - "delete skill"
    - "manage_skill"
    - "nb__manage_skill"
  keywords: [skill, behavior, customize, authoring, context, trigger, keyword, priority, allowed-tools]
---

# Skill Authoring Guide

When the user asks you to create, modify, or manage behavioral customizations,
use nb__manage_skill. Follow these guidelines:

## Choosing Type

- **context** (always active): For global behavior changes that apply to every
  message. Examples: language preference, response format, tone. Set priority
  11-30 for high-authority rules, 50-80 for soft preferences.
- **skill** (triggered): For domain-specific behavior that should only activate
  when relevant. Examples: compliance review, research mode, code review. Must
  have triggers and/or keywords.

## Writing Good Triggers

Triggers are exact substring matches. They should be:
- Specific enough to avoid false positives: "compliance review" not "review"
- Natural phrases users actually type: "check compliance" not "initiate
  compliance verification"
- 2-4 triggers per skill is typical

Avoid: single common words ("data", "help", "check"), verb-only triggers
("review", "search"), triggers that overlap with other skills.

## Writing Good Keywords

Keywords require 2+ hits to activate. They should be:
- Domain-specific terms: "compliance", "regulation", "policy", "audit"
- 5-10 keywords per skill is typical
- Include synonyms: "policy" AND "regulation" AND "rule"

Avoid: generic terms that appear in many domains.

## Writing the Body

The body is injected into the system prompt. It should:
- Be instructions TO the agent, not descriptions ABOUT the agent
- Use imperative voice: "Always cite section numbers" not "The agent should cite"
- Be specific about format: "Use bullet points with bold headers"
- Compose well: do not restate identity (soul.md) or tool discovery (bootstrap.md)
- Stay under 500 words — the body competes for context window space

## Tool Dependencies

If the skill needs specific tools:
- Set allowed_tools to scope tool visibility: ["policy_search__*"]
- Set requires_bundles to declare dependencies: ["@acme/policy-search"]
- Before creating, use nb__search with scope "tools" to verify tools exist
- If tools are missing, tell the user and offer to install via nb__manage_app

## Priority Guidelines

- 0-10: RESERVED for core skills. Never use.
- 11-20: High-authority user context (language, accessibility)
- 21-40: Medium-authority user context (formatting, tone)
- 41-60: Standard skills (default: 50)
- 61-80: Low-priority preferences
- 81-99: Fallback/catch-all skills

## What Skills Cannot Do

- Cannot change runtime config (maxIterations, model). Direct to nimblebrain.json.
- Cannot create tools. Users need an MCP server bundle for custom tools.
- Cannot override core identity (soul.md). They layer on top.

## Confirming with the User

Before creating or editing a skill, always show:
1. The skill name and type
2. Triggers and keywords (if type: skill)
3. A summary of the behavioral change
4. Any tool dependencies
5. Ask for confirmation

After creation, suggest a test phrase the user can try.
