// ---------------------------------------------------------------------------
// App channels — the one way the host posts to an app iframe.
//
// A bridge opens a channel for its iframe and closes it on teardown. Anything
// outside the bridge that addresses iframes from the DOM (the server
// notification relay, the conversation-title forwarder) posts through here, so
// its frames pass the bridge's handshake gate like the bridge's own: an app
// hears nothing but its `ui/initialize` response until it has sent
// `ui/notifications/initialized`. An iframe with no bridge has no channel, and
// a post to it goes nowhere.
// ---------------------------------------------------------------------------

type Post = (message: unknown) => void;

const channels = new WeakMap<HTMLIFrameElement, Post>();

/** Register `post` as the way to reach `iframe`. Returns the close function. */
export function openAppChannel(iframe: HTMLIFrameElement, post: Post): () => void {
  channels.set(iframe, post);
  return () => {
    if (channels.get(iframe) === post) channels.delete(iframe);
  };
}

/** Post `message` to the app in `iframe` through its bridge. */
export function postToApp(iframe: HTMLIFrameElement, message: unknown): void {
  channels.get(iframe)?.(message);
}
