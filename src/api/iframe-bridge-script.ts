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
 *   off(method, handler)  — unsubscribe a previously registered handler
 *   getHostOrigin()       — current pinned origin (or null pre-handshake)
 *
 * Suspicious rejections (claimed/actual origin mismatch on handshake,
 * post-handshake origin drift, postMessage failure) emit `console.warn`
 * so the failure mode is visible during development. Routine drops
 * (non-parent source, handlers that throw) stay silent.
 *
 * Served verbatim at `GET /iframe-bridge.js`.
 */
export const IFRAME_BRIDGE_SCRIPT = `(function () {
  if (typeof window === "undefined" || window.NBBridge) return;

  var hostOrigin = null;
  var pendingSend = [];
  var handlers = Object.create(null);

  function warn(msg, detail) {
    try {
      if (typeof console !== "undefined" && console.warn) {
        if (detail === undefined) console.warn("[NBBridge] " + msg);
        else console.warn("[NBBridge] " + msg, detail);
      }
    } catch (_) {}
  }

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
      try { window.parent.postMessage(queue[i], hostOrigin); }
      catch (e) { warn("postMessage failed during flush", e); }
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
      if (!claimed) return;
      if (claimed !== event.origin) {
        warn(
          "handshake rejected: claimed origin " + claimed +
          " does not match event.origin " + event.origin
        );
        return;
      }
      hostOrigin = claimed;
      flushPending();
    } else if (event.origin !== hostOrigin) {
      warn(
        "dropped message from unexpected origin " + event.origin +
        " (pinned host is " + hostOrigin + ")"
      );
      return;
    }
    dispatch(event.data);
  }

  window.addEventListener("message", handleMessage);

  window.NBBridge = {
    send: function (message) {
      if (hostOrigin) {
        try { window.parent.postMessage(message, hostOrigin); }
        catch (e) { warn("postMessage failed", e); }
      } else {
        pendingSend.push(message);
      }
    },
    on: function (method, handler) {
      if (typeof method !== "string" || typeof handler !== "function") return;
      if (!handlers[method]) handlers[method] = [];
      handlers[method].push(handler);
    },
    off: function (method, handler) {
      if (typeof method !== "string" || typeof handler !== "function") return;
      var list = handlers[method];
      if (!list) return;
      var idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) delete handlers[method];
    },
    getHostOrigin: function () { return hostOrigin; },
  };
})();
`;
