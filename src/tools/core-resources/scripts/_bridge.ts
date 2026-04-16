/**
 * Bridge helper for core resource client scripts.
 *
 * Creates a Synapse instance (from the Synapse IIFE injected by render.tsx)
 * and exposes convenience functions used by core UI scripts.
 *
 * Provides: synapse, callTool, action, navigate, sendChat, emitAction,
 * parseResult, setVisibleState, onDataChanged, _ready
 */
export const BRIDGE_HELPER = `
  var synapse = Synapse.createSynapse({ name: "nb-core", version: "1.0.0", internal: true });

  function callTool(name, args) {
    // Support "server__tool" format for cross-server calls from internal apps
    var toolName = name;
    var sep = name.indexOf("__");
    if (sep > 0) {
      // Synapse callTool sends the raw name; the bridge handles server routing
      // for internal apps via params.server. We need to pass the split names.
      var server = name.substring(0, sep);
      toolName = name.substring(sep + 2);
      return synapse._request("tools/call", {
        server: server, name: toolName, arguments: args || {}
      }).then(function(r) { return r; });
    }
    return synapse.callTool(toolName, args).then(function(r) { return r.data; });
  }

  function action(actionName, params) {
    synapse.action(actionName, params);
  }

  function navigate(route) {
    action("navigate", { route: route });
  }

  function sendChat(message) {
    synapse.chat(message);
  }

  function emitAction(actionName, params) {
    action(actionName, params);
  }

  function setVisibleState(state, summary) {
    synapse.setVisibleState(state, summary);
  }

  function onDataChanged(callback) {
    synapse.onDataChanged(callback);
  }

  function parseResult(result) {
    if (result && result.structuredContent) {
      return result.structuredContent;
    }
    return result;
  }

  var _ready = synapse.ready;
`;
