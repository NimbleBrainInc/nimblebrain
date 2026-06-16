/**
 * Kernel observability seam — vendor-neutral OpenTelemetry tracing + the
 * identity enrichment that rides on spans and structured logs.
 *
 * The runtime depends only on `@opentelemetry/*` and the W3C tracecontext /
 * OTLP wire formats; it does not take a dependency on any vendor or
 * platform-specific observability library. See `tracing.ts` for the rationale.
 */
export { requestIdentityAttrs } from "./identity.ts";
export {
  currentTraceId,
  initTracing,
  injectTraceparent,
  type SpanAttrs,
  type SpanHandle,
  shutdownTracing,
  type WithSpanOptions,
  withInboundSpan,
  withSpan,
} from "./tracing.ts";
