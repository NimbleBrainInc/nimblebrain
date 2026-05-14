/**
 * Inline-HTML bundle bridge helper (issue #99).
 *
 * Synapse bundles that don't use the React SDK still need a safe
 * postMessage path:
 *
 *   - Outbound (`bundle → parent`) must use the host's real origin as
 *     `targetOrigin`, not `"*"`. Otherwise a malicious page that frames
 *     the platform receives every JSON-RPC payload.
 *   - Inbound (`parent → bundle`) must validate both `event.source ===
 *     window.parent` and `event.origin === <captured host origin>`.
 *     Otherwise any window with an iframe reference can forge replies.
 *
 * Bootstrap: the very first valid parent message carries the host's
 * own origin (legacy `ui/initialize` notification's `apiBase` field or
 * the ext-apps response's `hostContext.origin`). We pin the host
 * identity only when that claimed origin matches the browser-reported
 * `event.origin` on the same message — that prevents a pretender from
 * registering itself as the host on the first message they send.
 *
 * Surface (attached to `window.NBBridge`):
 *   send(message)         — postMessage to parent with pinned origin
 *                           (queued until handshake captures origin)
 *   on(method, handler)   — subscribe to validated inbound notifications
 *   getHostOrigin()       — current pinned origin (or null pre-handshake)
 *
 * Served verbatim at `GET /iframe-bridge.js`. Also inlined into the
 * platform's own core-resource scripts so they don't have to fetch over
 * the wire (and don't need a CSP relaxation for that fetch).
 */
export const IFRAME_BRIDGE_SCRIPT = `(function () {
  if (typeof window === "undefined" || window.NBBridge) return;

  var hostOrigin = null;
  var pendingSend = [];
  var handlers = Object.create(null);

  function extractClaimedOrigin(data) {
    if (!data || typeof data !== "object") return null;
    if (data.method === "ui/initialize" && data.params && typeof data.params.apiBase === "string") {
      return data.params.apiBase;
    }
    if (data.result && data.result.hostContext && typeof data.result.hostContext.origin === "string") {
      return data.result.hostContext.origin;
    }
    return null;
  }

  function flushPending() {
    var queue = pendingSend;
    pendingSend = [];
    for (var i = 0; i < queue.length; i++) {
      try { window.parent.postMessage(queue[i], hostOrigin); } catch (e) {}
    }
  }

  function dispatch(data) {
    if (!data || typeof data !== "object" || typeof data.method !== "string") return;
    var list = handlers[data.method];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](data); } catch (e) {}
    }
  }

  function handleMessage(event) {
    if (event.source !== window.parent) return;
    if (!hostOrigin) {
      var claimed = extractClaimedOrigin(event.data);
      if (!claimed || claimed !== event.origin) return;
      hostOrigin = claimed;
      flushPending();
    } else if (event.origin !== hostOrigin) {
      return;
    }
    dispatch(event.data);
  }

  window.addEventListener("message", handleMessage);

  window.NBBridge = {
    send: function (message) {
      if (hostOrigin) {
        try { window.parent.postMessage(message, hostOrigin); } catch (e) {}
      } else {
        pendingSend.push(message);
      }
    },
    on: function (method, handler) {
      if (typeof method !== "string" || typeof handler !== "function") return;
      if (!handlers[method]) handlers[method] = [];
      handlers[method].push(handler);
    },
    getHostOrigin: function () { return hostOrigin; },
  };
})();
`;
