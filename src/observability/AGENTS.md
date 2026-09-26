# Observability

Scope: logging, debug namespaces, and OTel tracing (`src/observability/`), plus the browser debug flags in `web/src/lib/debug.ts`.

## Debug Logging

Hot-path diagnostics are gated behind namespace flags so they're available when you need them without editing source. Use for tracing across the runtime ↔ SSE ↔ browser ↔ iframe chain.

### Server (`NB_DEBUG` environment variable)

```bash
NB_DEBUG=*         bun run dev    # everything
NB_DEBUG=mcp       bun run dev    # MCP source lifecycle + dispatch
NB_DEBUG=sse,mcp   bun run dev    # SSE event flow + MCP
```

`NB_DEBUG` is read once at process start. Changing it mid-session (e.g. `export NB_DEBUG=...` in the running shell) has no effect — restart the process for the new namespaces to take hold.

Namespaces (`src/observability/log.ts`):

| Namespace | Emits | Answers |
|---|---|---|
| `mcp` | McpSource construction; per-call dispatch showing `taskSupport` / `path=task-augmented\|inline` / cached tool count | "Why is my tool going inline vs task-augmented?" "Is my tool cache populated?" |
| `sse` | Every `tool.progress` / `tool.done` / `server.notification` entering the runtime sink wrap | "Are progress events and relayed notifications reaching the SSE layer?" |
| `auth` | Identity-provider verify rejections at debug volume (the routine, self-healing reasons `no_token` / `token_expired`). Anomalous reasons — `org_mismatch`, `bad_signature`, `jwks_unavailable`, etc. — log at `warn` and need no flag. | "Why is a user being 401'd / involuntarily logged out?" |
| `notify` | Notification envelopes, outbox declarations and poll results dropped at parse, with the field that failed; sweeps skipped because a workspace is already being read | "Why is this connector's event not in the inbox?" |

Add a namespace by calling `log.debug("ns", "message")` (from `src/observability/log.ts`). Keep this table and the `log.ts` doc comment in sync.

### Browser (`localStorage.nb_debug`)

```js
localStorage.setItem("nb_debug", "*")        // everything
localStorage.setItem("nb_debug", "sync")     // just the server-notification relay
localStorage.removeItem("nb_debug")          // off
```

Reload after setting. Namespaces (`web/src/lib/debug.ts`):

| Namespace | Emits | Answers |
|---|---|---|
| `sync` | Every SSE `server.notification` arrival; each drop (method not relayed, another workspace); each `postMessage` forward to a matching iframe | "Is the browser receiving broadcasts?" "Is the iframe I expect actually mounted with the right `data-app`?" |

Namespaces are shared convention between server and browser: `NB_DEBUG=sync` plus `localStorage.nb_debug=sync` together trace the entire relay, from the server's announcement to the iframe.

## Observability (OTel tracing + structured logs)

Vendor-neutral OpenTelemetry lives in `src/observability/`. The runtime depends only on `@opentelemetry/*` and the W3C tracecontext + OTLP wire formats — **never** a branded observability library. The wire is the interface.

- **Spans:** wrap work with `withSpan(name, attrs, fn)` (active-context, nests automatically) — never call the OTel API directly from feature code. Today's spans: `agent.turn` (engine run), `llm.call` (model stream), `tool.dispatch` (MCP dispatch), and the outer HTTP span (Hono middleware, continues an inbound `traceparent`). Add `requestIdentityAttrs()` to span attrs to stamp the verified identity.
- **Propagation:** `injectTraceparent(headers)` on outbound calls that should extend the trace (service-token mint, authenticated remote-MCP fetch). No-op outside a span.
- **Logs:** use `log.*(msg, fields?)` from `src/observability/log.ts` — never raw `console.*` in operational code (it bypasses the JSON/identity/correlation enrichment). With `NB_LOG_FORMAT=json` (set by the chart) lines are structured JSON auto-enriched with `service`, `tenant_id`, `trace_id` (the active OTel trace id — the field the Grafana Loki→Tempo pivot keys on), and identity; pretty dev output is unchanged. `NB_LOG_LEVEL` (default `info`) is the severity floor for info/warn/error; secret-keyed `fields` (a bare `token`, the `*_token` compounds, `secret`/`password`/`api_key`/`authorization`/`cookie`/`credential`) are auto-redacted before write, while LLM usage fields (`inputTokens`/`tokenCount`/…) are preserved. `check:no-raw-console` enforces the logger usage (the console/debug EventSinks are exempt; a rare exception takes a `// lint-ok:console` marker).
- **Trust rule — what may be stamped:** `tenant_id` is a boot-time Resource attribute from `NB_TENANT_ID`, never a request header. `user_id` / `workspace_id` / `conversation_id` come from the verified request context. **Never** stamp the display name, email, secrets, prompts, tool args/results, or file contents.
- **Config:** `OTEL_EXPORTER_OTLP_ENDPOINT` enables export (unset = nothing exported, ids still exist for log correlation — so local dev and OSS checkouts need no infra). `NB_SERVICE_NAME` overrides the service name.
- **OTel deps are exact-pinned to one release train** (stable `sdk-trace-*`/`resources` + the matching experimental exporter). Bump them together or export serialization breaks; the version-coherence test in `test/unit/observability.test.ts` guards it.
