/**
 * Stands in for the app inside an app frame (`createAppIframe`, `web/src/bridge/iframe.ts`):
 * loads the frame page the shell nests the app in, and replaces the nested app's window with
 * `appWindow`. `post` sends a message as the app does, to its parent, the frame page.
 */
export function loadAppFrame(iframe: HTMLIFrameElement, appWindow: Pick<Window, "postMessage">) {
  const page = document.implementation.createHTMLDocument("app frame");
  page.body.setAttribute("data-app-frame", "");
  // The frame page's `postToApp`, which the shell sends through.
  const pageWindow = Object.assign(new window.EventTarget(), {
    postToApp: (message: unknown) => appWindow.postMessage(message, "*"),
  });
  Object.defineProperty(iframe, "contentDocument", { configurable: true, get: () => page });
  Object.defineProperty(iframe, "contentWindow", { configurable: true, get: () => pageWindow });
  iframe.dispatchEvent(new window.Event("load"));
  const app = page.body.querySelector("iframe");
  if (!app) throw new Error("the app frame built no app");
  Object.defineProperty(app, "contentWindow", { configurable: true, get: () => appWindow });
  return {
    /** The app's own frame, inside the frame page. */
    app,
    post(data: unknown): void {
      const event = new window.MessageEvent("message", { data });
      Object.defineProperty(event, "source", { configurable: true, get: () => appWindow });
      pageWindow.dispatchEvent(event);
    },
  };
}
