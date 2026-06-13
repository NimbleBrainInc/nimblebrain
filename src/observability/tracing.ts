/**
 * Vendor-neutral OpenTelemetry tracing for the runtime kernel.
 *
 * The kernel depends only on the open OTel + W3C tracecontext primitives — never
 * on a vendor or platform-specific observability library. The wire is the
 * interface: spans export over OTLP to whatever collector the operator points
 * `OTEL_EXPORTER_OTLP_ENDPOINT` at, and a trace continues across process hops via
 * the standard W3C `traceparent` header. With the endpoint unset — the default,
 * including local `bun run dev` and every OSS checkout — nothing is exported.
 * Trace ids still exist in-process so logs carry a correlation id, but NO infra
 * is required to run the runtime.
 *
 * OTel JS ships **stable** packages (`api`, `sdk-trace-*`, `resources`) and
 * **experimental** ones (the OTLP exporter, 0.x). They must come from the same
 * release train or serialization fails at export (`instrumentationLibrary` vs
 * `instrumentationScope`). Keep `package.json` pinned to a coherent set; the
 * version-coherence test guards it.
 */
import {
  type Attributes,
  context,
  propagation,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const SERVICE_NAME = process.env.NB_SERVICE_NAME ?? "nimblebrain-runtime";
const TRACER_NAME = "nimblebrain-runtime";
const INVALID_TRACE_ID = "00000000000000000000000000000000";

let configured = false;

/**
 * Install tracing for this process. Idempotent — safe to call from every entry
 * point (serve, dev, automations, tests). Reads two operator knobs:
 *   - `OTEL_EXPORTER_OTLP_ENDPOINT` — collector base URL; unset = no export.
 *   - `NB_TENANT_ID` — this deployment's tenant; stamped on the Resource so
 *     every span carries it and it cannot be spoofed by a request.
 */
export function initTracing(): void {
  if (configured) return;
  configured = true;

  const attrs: Attributes = { [ATTR_SERVICE_NAME]: SERVICE_NAME };
  // The runtime process belongs to exactly one tenant; the tenant id is a
  // boot-time constant from the deployment (chart -> NB_TENANT_ID), never a
  // request header. On the Resource it rides every span and is structurally
  // unspoofable. Unset in local/dev — omit rather than fake.
  const tenantId = process.env.NB_TENANT_ID;
  if (tenantId) attrs.tenant_id = tenantId;

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes(attrs),
    spanProcessors: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? [new BatchSpanProcessor(new OTLPTraceExporter())]
      : [],
  });
  // register() installs the W3C tracecontext propagator + an AsyncLocalStorage
  // context manager, so active-span nesting works under Bun.
  provider.register();
}

const tracer = () => trace.getTracer(TRACER_NAME);

/** Span attributes — low-cardinality string/number/boolean only. NEVER secrets,
 *  prompts, tool arguments/results, or file contents. */
export type SpanAttrs = Attributes;

/** A minimal handle so call sites can add late attributes (token counts, etc.)
 *  or refine the span name without importing the OTel API directly. */
export interface SpanHandle {
  setAttrs(attrs: SpanAttrs): void;
  /** Rename the span once a low-cardinality label is known (e.g. an HTTP route
   *  resolved only after routing). Pass a TEMPLATE, never a raw path with ids. */
  setName(name: string): void;
}

class SpanHandleImpl implements SpanHandle {
  constructor(private readonly span: Span) {}
  setAttrs(attrs: SpanAttrs): void {
    this.span.setAttributes(attrs);
  }
  setName(name: string): void {
    this.span.updateName(name);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run `fn` inside a new active span. The span is the active context for the
 * duration, so any span started inside `fn` nests under it automatically.
 * Records the exception + ERROR status on throw, and always ends the span.
 * Cheap when no exporter is configured (the SDK still threads context).
 */
export async function withSpan<T>(
  name: string,
  attrs: SpanAttrs,
  fn: (span: SpanHandle) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, async (span: Span) => {
    span.setAttributes(attrs);
    try {
      return await fn(new SpanHandleImpl(span));
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMessage(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Run `fn` as an active span continued from an inbound `traceparent` (e.g. the
 * mcp-edge -> runtime hop). With no inbound context present it opens a fresh
 * root span. Used by the HTTP middleware.
 */
export async function withInboundSpan<T>(
  name: string,
  inboundHeaders: Headers,
  attrs: SpanAttrs,
  fn: (span: SpanHandle) => Promise<T>,
): Promise<T> {
  const carrier: Record<string, string> = {};
  inboundHeaders.forEach((v, k) => {
    carrier[k] = v;
  });
  const parent = propagation.extract(context.active(), carrier);
  return context.with(parent, () => withSpan(name, attrs, fn));
}

/** The active trace id (32-hex), or undefined outside any span. For log
 *  correlation — emit it as `correlation_id` so logs pivot to traces. */
export function currentTraceId(): string | undefined {
  const ctx = trace.getActiveSpan()?.spanContext();
  if (!ctx || ctx.traceId === INVALID_TRACE_ID) return undefined;
  return ctx.traceId;
}

/**
 * Inject the active W3C `traceparent` into an outbound header carrier so the
 * trace continues into the next hop (remote MCP server, service-token mint).
 * Identity rides its own verified headers separately — traceparent is
 * correlation, never authority. Mutates and returns the carrier.
 */
export function injectTraceparent<T extends Headers | Record<string, string>>(headers: T): T {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  for (const [k, v] of Object.entries(carrier)) {
    if (headers instanceof Headers) headers.set(k, v);
    else (headers as Record<string, string>)[k] = v;
  }
  return headers;
}
