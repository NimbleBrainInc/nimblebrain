# 0060. The URL carries the target an app shows

- Status: Proposed
- Date: 2026-11-02
- Serves: orchestrate remote MCP, secure RBAC
- Amends: [ADR-0052](./0052-a-view-opens-what-it-names-by-uri.md) (where an open's target travels)

## Context

**Terms.** A *placement* is one of an app's sidebar sections, addressed by its `ui://` URI. A
*target* is the address of what the app shows inside a placement, usually a record's resource
URI. ADR-0052 introduced the target (`OpenDestination.target`). The bridge hands it to the app as
`ai.nimblebrain/navigate`, and the app reports where it is as the last entry of its
`ai.nimblebrain/location` trail.

An app route's URL names only the placement: `/w/<slug>/app/<route>`. The target travels as
router state (`appTarget`) and lives in the app and in the top bar's trail. None of those
survives a page load, so a person cannot keep their place:

- **Reload** a record and the app comes back at its home.
- **Share** the URL and the recipient lands on the app's home.
- **Back** skips everything the person did inside the app.

This is a shell concern: every app with records has it, and no app can fix it from inside its
sandboxed frame.

## Decision

### The URL is the durable carrier of a linkable target

**An app route's query parameter `target` holds the target the app shows, when that target is
linkable.** With no `target`, the app shows its home.

**A target is linkable only when its record template says so.** A resource template that
declares `_meta["ai.nimblebrain/link"]: true`, beside ADR-0059's `ai.nimblebrain/view`, accepts
its records as targets from a link. A placement's own `ui://` URI is its home, and is never
written. An app opts in per record kind, after it keeps the rules for apps below.

| Move | Delivery | URL |
|---|---|---|
| An open (`ai.nimblebrain/open`, `nb__open_app`) of a linkable target | the resolved target, once, from memory | pushes the target |
| An open of a target that is not linkable | the resolved target, once, from memory | pushes the placement, without `target` |
| Choosing a placement in the sidebar | the placement's home | pushes the placement |
| Picking an entry in the top bar | that entry | pushes it when linkable |
| The app's own trail report (a tab, a filter, a record chosen inside the app) | none | replaces the current entry when the new target is linkable, and drops `target` when it is not |

So Back undoes a jump and never steps through tab clicks. Router-state `appTarget` is removed.

**A target the shell has just resolved is handed over once, from memory.** It is keyed to the
navigation that carried it, held only in the shell's memory, and honoured only on the push that
created it. It is never stored in history state. So a reload, a restored session, a duplicated
tab, Back and Forward always resolve again, and a replace never carries a handover over.

### Every target read from the URL is untrusted, and is resolved before it is delivered

This covers a page load, a pasted link, and every Back and Forward. The steps run in order, and a
failure at any step drops the target.

1. **Shape.** The value is one `target` parameter of 1 to 512 characters after decoding (the
   trail's and the resolver's own limit). It is a URI whose scheme matches `[a-z][a-z0-9+.-]*:`,
   and every character is printable ASCII (`0x21` to `0x7E`). `javascript:`, `data:`,
   `vbscript:`, `blob:` and `file:` are never targets. An empty value, or more than one
   `target`, counts as none.
2. **Resolve.** The value goes through the same resolver as `ai.nimblebrain/open` (ADR-0052,
   ADR-0059), in the workspace the route names. That workspace is passed explicitly, never taken
   from the active workspace, which can lag the route by a render. Resolution starts only after
   the membership list has loaded and contains the route's workspace.
3. **Match.** The resolver's destination is this route's own placement, and the matched template
   is linkable. A refusal, a conversation, another app, or another placement of this app fails
   this step. A URL never moves the person to another route.
4. **Deliver.** The app receives `ai.nimblebrain/navigate`.

A dropped target is replaced out of the URL, and the app shows its home. A resolution that
finishes after the location has changed is discarded. A URL change the host made itself never
starts a resolution. On Back or Forward to an entry with no `target`, the host sends the
placement's own `ui://` URI as `navigate`, so the screen and the URL agree.

### The host writes the URL carefully

- **Linkable, by the client's own match.** For each placement, the host fetches the linkable
  templates of the placement's server once, through an action on an existing platform tool that
  names the workspace explicitly. It checks a trail entry against them in the browser before
  writing it, by the resolver's own rules: the template's `ai.nimblebrain/view` names this
  placement, or is absent and this placement is the server's first, and no other server claims
  the URI. No trail report causes a server call. The list is cleared when the workspace's
  placements or the server's templates change. Delivery from a URL is always resolved on the
  server, so a client that writes too much produces a link that lands at home, never a target
  delivered unchecked.
- **The same shape check as a read** (step 1) before every write.
- **Changes only, throttled.** The host writes only when the target changes, at most once per
  250 ms, using the trailing value.
- **The routed placement only.** A trail report from any other frame is never written.
- **Keeps other parameters.** The new URL is built from the current location, so `?chat=` and
  the rest are kept.
- **Opaque handling.** The host never renders `target`, never puts it in an `href`, a `src` or
  `window.location`, never logs it, and never puts it in a prompt.
- **Rate-limited opens.** An app's own `ai.nimblebrain/open` requests are rate-limited like its
  notices, so an app cannot fill the history and trap Back.

### Template matching is bounded

Templates come from connectors, so the shell (in the browser) and the resolver (on the server)
compile each template once per connection. A boundary between two expressions is ambiguous when
the text after the first (the literal, then the second's prefix) holds no character the first's
compiled class excludes: `{x}` excludes `/` and `,`, `{;x}` only `/`, `{?x}` only `&`, and
`{+x}` nothing. A template with more than one ambiguous boundary matches nothing, so matching a
URI of at most 512 characters costs at most quadratic work, and `{id}{?cursor}` still matches.

### App frames cannot see the shell's URL

A `srcdoc` frame takes its container's URL as its base URL, and its outgoing requests name the
container as their referrer. So today any app on screen can read the shell's full URL, `?chat=`
included. **`target` is not written until each app frame renders inside a same-origin frame at a
fixed path with no query** (the double-frame pattern the sandbox-proxy work already plans). An
app's base URL and referrer then name that fixed path, not the person's place. That frame page
has its own handler with no fallback to the shell, so a missing page never boots the signed-in
shell inside a frame. Only that path may be framed, and only by this origin. The bridge keys
its trust on the inner frame's window, and the outer page neither relays nor accepts messages.

### The rules for apps (the bridge contract)

1. **`navigate` is a request to show, never to act.** Receiving an address may read; it never
   writes, sends, approves, deletes, or opens a confirmation. Treat every `navigate` as
   untrusted, whatever started it.
2. **An address names a record by an opaque id**, never by personal data or a name a person
   chose: no email, title or free text in a URI.
3. **A view that cannot show an address goes home or stays where it is, and says nothing about
   it.** It never echoes the address or the reason in its own text, so a record the viewer
   cannot read looks the same as one that does not exist.

## Security model

The link is the attacker's channel: anyone can send anyone a URL to an app route.

| Threat | Bound |
|---|---|
| A link makes the app *do* something (approve, send, delete) | Only templates that opt in take a target from a link, and opting in means keeping rule 1. Tool-bound views, such as a send-confirmation card, are not placements, so no address resolves to them. |
| A link sends the person to another app or site | Delivery is limited to this route's own placement. The value never reaches `window.location` or an `href`, so there is no open redirect. Scanners flag a parameter named `target` for that reason; this is the line that answers them. |
| A malicious app plants a target for another app | The host writes only targets linkable for the placement on screen, and resolves again on every load and every Back. |
| A stale or forged "already resolved" handover | It lives only in memory, for the one push that made it. History state never carries it, so nothing survives a reload, and no other page can forge one. |
| A non-linkable open replayed on reload | It is delivered once from memory and never written to the URL. |
| A link reaches another workspace's data | Resolution runs only after the membership list contains the route's workspace, in that workspace. The app reads through its own tools, where its server's permissions apply. |
| A link reveals whether a record exists | The resolver reads no app record; it only matches templates. A `conversation://` address is checked against the caller's own conversations, and every conversation destination is dropped here. Apps never echo an address or a reason (rule 3). |
| Attacker text shown in trusted chrome | The host never renders `target`. Apps never echo it (rule 3). The kernel Files app fixes its echo before it opts in. |
| Script injection | The value is shape-checked to printable ASCII, dangerous schemes are refused, and the app receives it as a JSON string over `postMessage`. |
| Prompt injection | Neither the trail nor `target` reaches the model. A link can choose which readable record an app shows, and so what app state the app pushes before the person's next turn. That state stays inside `<app-state>` containment, and the record is one the viewer can already read. Accepted. |
| A page frames the shell at a chosen record (clickjacking) | The shell document sends `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`: nothing frames it, not even a page on this origin. Only the fixed frame path allows `frame-ancestors 'self'`. |
| Another app on screen reads where the person is | App frames render inside a same-origin frame at a fixed path, so their base URL and referrer carry no `target` and no `?chat=`. `target` is not written before that ships. |
| Leaking targets to third parties | The shell document sends `Referrer-Policy: strict-origin-when-cross-origin`. Telemetry strips the query from every URL it sends: Sentry events, breadcrumbs (`from` and `to` included) and transactions, and every PostHog property whose value is a URL on the shell's origin, `$initial_*` included. Addresses are opaque ids (rule 2). |
| Link previews and server-side fetches | The shell is a static page that serves no data without a session; a preview sees the sign-in screen. |
| Denial of service through matching | Values are capped at 512 characters. Templates are compiled once, and one that could backtrack without bound matches nothing. Trail reports are checked in the browser, so they never spend the person's server budget. |
| History flooding | Trail writes are throttled to the trailing value every 250 ms. Opens an app asks for are rate-limited. |

## Consequences

- **Reload, share and Back work for every app that opts its record templates in.** An app that
  does not opt in gets every open once, as today, and its URL stays at the placement. Back
  returns it to the placement's home rather than to the record it showed.
- **Router-state `appTarget` is removed.** A linkable target travels in the URL, and a just-resolved
  handover in memory.
- **Order of work.** Shell hardening first: the headers, the telemetry stripping, the template
  bounds, and app-frame isolation. These close gaps that exist today, including `?chat=`
  reaching every app frame. Writing `target` comes after them.
  - `web/Caddyfile` sets `Referrer-Policy`, `frame-ancestors 'none'` and
    `X-Frame-Options: DENY` on the shell document.
  - `web/src/sentry.ts` strips the query from event, breadcrumb and transaction URLs, and
    `web/src/telemetry.ts` from every URL-valued PostHog property.
  - The resolver and the shell compile templates once, and refuse runaway ones.
  - App frames render inside a same-origin frame at a fixed path. Verify in a browser before and
    after: `document.baseURI`, `document.referrer`, the base after script removes any `<base>`,
    and the `Referer` an `<img referrerpolicy="unsafe-url">` sends.
- **Stored file bytes are served on the shell's origin** (`/v1/files/:fileId`) under the API's
  CSP, which an operator can disable. Serving them with `Content-Security-Policy: sandbox`
  whatever that setting says is separate hardening, and this decision does not depend on it.
- **The kernel's own apps keep the rules before they opt in.** Files stops echoing an unknown
  address, and Tasks stops putting task names in its trail ids.
- **The bridge documentation states the three rules and `ai.nimblebrain/link`,** so a
  third-party app can opt in without reading host source.
- **Conversations keep their own `?chat=` link.** `target` covers app placements only.
