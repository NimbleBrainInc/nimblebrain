# 0018. Where each skill channel sits relative to the cache breakpoints

- Status: Proposed
- Date: 2026-09-03
- Serves: manage skills

## Context

Golden rule 1 says skills load *without busting the prompt cache*. Whether that
holds is a property of where each channel's bytes land relative to the cache
breakpoints, and the four channels do not land in the same place.

The cache policy (`src/model/cache-policy.ts`) places four breakpoints — tools,
system, a rolling step-anchor, and the tail — and tiers the TTL by stability:
one hour on the stable prefix (system plus tools), five minutes on the rolling
history. A change anywhere in the system prompt invalidates the system
breakpoint and everything after it.

The composer (`src/prompt/compose.ts`) already classifies each layer as stable or
volatile, and evicts volatile layers out of the cached prefix onto the latest
user message. Against that classification, the channels sit as follows:

- **`always` (context channel).** Stable. Composed into the system prompt every
  turn from content that only changes when a skill is authored or installed. This
  is the channel the rule is written about, and it holds.
- **Catalog.** Stable, and byte-stable by construction (ADR-0015) — name and
  description only, sorted, deduplicated.
- **Trigger matcher.** Classified volatile, so it is evicted onto the latest user
  message rather than mutating the prefix. Correct by construction: it varies per
  message.
- **Tool-affinity (turn-start selection).** Classified **stable**, and composed
  into the system prompt — but its content is recomputed at each turn's start
  against the active tool set. When that set changes between turns, the section's
  bytes change, and the system breakpoint misses along with everything after it.

The last one is the open question. It is not incorrect — a cache miss is a cost,
never a wrong answer — and it is not obviously wrong either: a tool set that is
stable across a conversation makes the section stable in practice, and the
alternative placements have costs of their own. But "stable" is currently a
claim about the layer's kind rather than about its bytes, and nothing measures
the gap.

## Options

**A. Leave it.** Accept that the tool-affinity section is stable in the common
case and busts the prefix when the tool set moves. Cheapest, and possibly
already right.

**B. Reclassify tool-affinity as volatile.** Evict it onto the latest user
message with the matched skill. Guarantees the system prefix never moves for this
reason. Cost: the selected bodies re-write into the rolling history every turn
instead of being read from the 1-hour prefix, which is cheaper per turn only if
the section actually changes often.

**C. Order the system prompt by volatility.** Place every section that can move
after everything that cannot, so a change invalidates the smallest possible
suffix. This helps regardless of which way A/B goes, and is orthogonal to it.

**D. Make the classification a measured property, not a declared one.** Hash each
section's bytes across turns and record which breakpoint actually got invalidated
and by what. Turns the question from a design argument into a reading.

## What would decide it

- **How often the active tool set actually changes mid-conversation**, and
  therefore how often the tool-affinity section's bytes move. Tool promotion,
  connector install, and the supervisor tripping a tool are the known causes; the
  rates are not known.
- **Measured cache-read ratio and cache-write volume, attributed to the section
  that changed.** The existing usage records carry cached-read and cache-write
  counts per call, tiered by TTL. Attributing an invalidation to a section is the
  missing half, and option D is what supplies it.
- **The size of the selected bodies.** A section that is a few hundred tokens and
  moves occasionally is noise. One that is several thousand tokens and moves on a
  third of turns is the dominant term in the run's cost, and it decides A against
  B on its own.
- **Whether any measurement exists that would catch a regression.** Today's
  byte-stability is a property of how the code is written, not something a test
  asserts. Whatever is decided, the decision is only durable if something fails
  when a future field breaks it.
