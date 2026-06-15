import { SpanStatusCode } from "@opentelemetry/api";
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { log } from "../../src/cli/log.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import {
  currentTraceId,
  injectTraceparent,
  requestIdentityAttrs,
  withSpan,
} from "../../src/observability/index.ts";
import { type RequestContext, runWithRequestContext } from "../../src/runtime/request-context.ts";

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  // Register a provider with an in-memory exporter so withSpan() produces real,
  // inspectable spans. No OTLP endpoint — matches the no-export default path.
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

beforeEach(() => {
  exporter.reset();
});

const PII_EMAIL = "secret@example.com";
const PII_NAME = "Jane Secret";

function identityCtx(): RequestContext {
  const identity: UserIdentity = {
    id: "user_123",
    email: PII_EMAIL,
    displayName: PII_NAME,
    orgRole: "member",
    preferences: {},
  };
  return {
    identity,
    scope: {
      kind: "workspace",
      workspaceId: "ws_abc123",
      workspaceAgents: null,
      workspaceModelOverride: null,
    },
    conversationId: "conv_9",
  };
}

function spanNamed(name: string) {
  const span = exporter.getFinishedSpans().find((s) => s.name === name);
  if (!span) throw new Error(`span ${name} not found`);
  return span;
}

describe("withSpan", () => {
  it("returns the wrapped function's result and ends the span", async () => {
    const result = await withSpan("agent.turn", { "llm.model": "anthropic:x" }, async () => 42);
    expect(result).toBe(42);
    expect(spanNamed("agent.turn").attributes["llm.model"]).toBe("anthropic:x");
  });

  it("records the exception and marks ERROR on an unexpected error", async () => {
    await expect(
      withSpan("tool.dispatch", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Span still ended (exported) and is marked failed.
    expect(spanNamed("tool.dispatch").status.code).toBe(SpanStatusCode.ERROR);
  });

  it("does not mark the span failed for an expected (cancelled) error", async () => {
    await expect(
      withSpan(
        "tool.dispatch",
        {},
        async () => {
          throw new Error("aborted");
        },
        { isExpectedError: () => true },
      ),
    ).rejects.toThrow("aborted");
    const span = spanNamed("tool.dispatch");
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes.cancelled).toBe(true);
  });

  it("nests child spans under the active span (same trace, parent linked)", async () => {
    await withSpan("agent.turn", {}, async () => {
      await withSpan("llm.call", {}, async () => {});
    });
    const turn = spanNamed("agent.turn");
    const child = spanNamed("llm.call");
    expect(child.spanContext().traceId).toBe(turn.spanContext().traceId);
    expect(child.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
  });
});

describe("currentTraceId / injectTraceparent", () => {
  it("has no trace id and injects no traceparent outside a span", () => {
    expect(currentTraceId()).toBeUndefined();
    expect(injectTraceparent({} as Record<string, string>).traceparent).toBeUndefined();
  });

  it("exposes a 32-hex trace id and injects traceparent inside a span", async () => {
    await withSpan("agent.turn", {}, async () => {
      const id = currentTraceId();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      const headers = injectTraceparent({} as Record<string, string>);
      expect(headers.traceparent).toContain(id ?? "");
    });
  });
});

describe("requestIdentityAttrs — trust + PII boundary", () => {
  it("returns nothing outside a request context", () => {
    expect(requestIdentityAttrs()).toEqual({});
  });

  it("stamps only opaque ids — never email or display name", () => {
    runWithRequestContext(identityCtx(), () => {
      const attrs = requestIdentityAttrs();
      expect(attrs.user_id).toBe("user_123");
      expect(attrs.workspace_id).toBe("ws_abc123");
      expect(attrs.conversation_id).toBe("conv_9");
      const serialized = JSON.stringify(attrs);
      expect(serialized).not.toContain(PII_EMAIL);
      expect(serialized).not.toContain(PII_NAME);
    });
  });

  it("keeps PII off the span attributes", async () => {
    await runWithRequestContext(identityCtx(), () =>
      withSpan("agent.turn", requestIdentityAttrs(), async () => {}),
    );
    const serialized = JSON.stringify(spanNamed("agent.turn").attributes);
    expect(serialized).toContain("user_123");
    expect(serialized).not.toContain(PII_EMAIL);
    expect(serialized).not.toContain(PII_NAME);
  });
});

describe("structured logger (JSON mode)", () => {
  it("emits enriched JSON with identity + correlation, never PII", async () => {
    process.env.NB_LOG_FORMAT = "json";
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // @ts-expect-error narrow override for capture
    process.stderr.write = (chunk: string) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      // Inside a span so the line carries a correlation id (the trace id).
      await runWithRequestContext(identityCtx(), () =>
        withSpan("agent.turn", {}, async () => {
          log.info("turn.start", { iteration: 1 });
        }),
      );
    } finally {
      process.stderr.write = orig;
      process.env.NB_LOG_FORMAT = undefined;
    }
    const rec = JSON.parse(lines.join("").trim());
    expect(rec.level).toBe("info");
    expect(rec.service).toBe("nimblebrain-runtime");
    expect(rec.message).toBe("turn.start");
    expect(rec.user_id).toBe("user_123");
    expect(rec.workspace_id).toBe("ws_abc123");
    expect(rec.iteration).toBe(1);
    expect(rec.correlation_id).toMatch(/^[0-9a-f]{32}$/);
    // PII never appears anywhere in the serialized line.
    expect(rec.displayName).toBeUndefined();
    const joined = lines.join("");
    expect(joined).not.toContain(PII_EMAIL);
    expect(joined).not.toContain(PII_NAME);
  });
});

describe("OTel dependency coherence", () => {
  it("pins the stable + experimental packages to one release train", async () => {
    const pkg = await Bun.file(`${import.meta.dir}/../../package.json`).json();
    const d = pkg.dependencies as Record<string, string>;
    expect(d["@opentelemetry/api"]).toBe("1.9.1");
    expect(d["@opentelemetry/exporter-trace-otlp-http"]).toBe("0.219.0");
    // The stable SDK packages must share one version; the exporter is the
    // matching 0.2xx experimental line. Bump them together or export
    // serialization fails (instrumentationLibrary vs instrumentationScope).
    expect(d["@opentelemetry/sdk-trace-base"]).toBe("2.8.0");
    expect(d["@opentelemetry/sdk-trace-node"]).toBe(d["@opentelemetry/sdk-trace-base"]);
    expect(d["@opentelemetry/resources"]).toBe(d["@opentelemetry/sdk-trace-base"]);
  });
});
