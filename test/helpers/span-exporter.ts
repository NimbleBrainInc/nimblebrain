/**
 * One in-memory span exporter for the whole test process.
 *
 * The OTel global tracer provider can be registered once per process, and
 * `bun test` runs every file in one process, so a second file registering its
 * own provider would silently export nowhere. Every test that inspects spans
 * imports this exporter instead; the module registers the provider on first
 * import.
 */
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

export const spanExporter = new InMemorySpanExporter();

new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] }).register();
