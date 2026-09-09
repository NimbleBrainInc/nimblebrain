/**
 * Bridge helper for core resource client scripts.
 *
 * Connects through the Synapse IIFE that `render.tsx` injects, and exposes the
 * three functions those scripts call — `callTool`, `navigate`, `parseResult` —
 * over a fourth, `action`, which is the host channel `navigate` rides on.
 *
 * `callTool` resolves to the tool's own payload: the SDK normalizes a
 * `CallToolResult` down to `data` (structured content, or the first text block
 * parsed as JSON), and the helper hands back that. `parseResult` therefore only
 * has anything left to do for a tool that nests a `structuredContent` key
 * inside its own output; the served scripts unwrap defensively rather than
 * because a live host has ever handed them the envelope.
 *
 * `connect()` resolves only once the host has answered `ui/initialize`, so
 * `_ready` is the promise every helper sequences behind. Scripts never await it
 * themselves — each helper resolves it internally and hands back a promise the
 * caller was already handling. That is the whole shape of the port from the
 * removed synchronous API: there is no client object to hold, only a promise of
 * one.
 */
export const BRIDGE_HELPER = `
  var _ready = Synapse.connect({ name: "nb-core", version: "1.0.0", internal: true });

  function callTool(name, args) {
    // "server__tool" addresses a sibling server. An internal app's calls default
    // to its own name, so reaching another one is an explicit \`server\`.
    var sep = name.indexOf("__");
    var tool = sep > 0 ? name.substring(sep + 2) : name;
    var options = sep > 0 ? { server: name.substring(0, sep) } : undefined;
    return _ready.then(function (app) {
      return app.callTool(tool, args || {}, options).then(function (r) { return r.data; });
    });
  }

  function action(name, params) {
    return _ready.then(function (app) { Synapse.action(app, name, params); });
  }

  function navigate(route) {
    return action("navigate", { route: route });
  }

  function parseResult(result) {
    if (result && result.structuredContent) {
      return result.structuredContent;
    }
    return result;
  }
`;
