# 0050. A server's URL request reaches a person, or comes back as a link

- Status: Proposed
- Date: 2026-10-06
- Serves: orchestrate remote MCP, secure RBAC

## Context

Some tool calls must not complete on a model's word: sending a batch of email,
spending money, deleting a person's data. The server that owns the action needs a
person to confirm it, and needs to know the confirmation came from that person
and not from the agent relaying it. A model that says "the user approved" is not
evidence: the same words can arrive in a prospect's reply or a scraped page.

MCP Apps answer this inside a host that renders views. A tool whose
`ui.visibility` is `["app"]` is hidden from the model, and this host refuses an
app-only call unless the caller names a source and its credential is
first-party (`isAppCall`, `src/api/mcp-server.ts`). Under an identity provider
that issues external clients their own `resource` tokens, that leaves a click in
the view as the way to reach it; a provider that marks every credential
first-party (`oidc`, `dev`) does not hold that line, as `isAppCall` records. A
client that renders no views (a terminal agent) has no button at all.

URL-mode elicitation (introduced in `2025-11-25`) is the spec's answer for that
case. The server hands the client a URL; the client shows it, asks the person for
consent, and opens it outside the model's reach; the person completes the
interaction on the server's own page; the server checks its own state. On
`2026-07-28` this is an `InputRequiredResult` carrying an `elicitation/create`
request with `mode: "url"`, and the client retries the original `tools/call` with
`inputResponses` and the echoed `requestState`. Nothing blocks: the call returns
at once and the retry is the client's.

This host stands between the two ends. An outside client calls a source's tool
through `/mcp`; the runtime is the server to that client and the client to the
source. ADR-0023 claims no elicitation toward sources, and an input request
today fails on both paths: the task wire cancels the task
(`src/tools/mcp-task-client.ts`), and an inline call is rejected by the SDK,
which accepts an `input_required` result only when the caller opts in. ADR-0023's
reason, "elicitation has no answerer here", holds for form mode, which asks a
question and waits behind the call. It does not hold for a relayed URL request:
the answerer is the outside client's person, and nothing here waits.

## Decision

**The runtime relays a source's URL-mode input request to a caller that can show
it, and claims URL mode only on the requests where it can.**

- **The claim is per request, on `2026-07-28`, inline calls only.** When a
  `/mcp` caller's own request claims `elicitation.url` and the call runs inline,
  the runtime's call to the source claims `elicitation: { url: {} }` in that
  request's client capabilities. No other call claims it:
  - not a task-augmented call, whose input request the task wire cancels;
    relaying a task's input request is a separate decision;
  - not the runtime's own agent turns or an unattended run, which have no one to
    show a link to;
  - not a 2025-era connection, where the claim is made once in `initialize` for
    the whole connection, so it cannot be limited to the calls of a caller that
    claimed it.

  Form mode is never claimed.
- **A URL request is passed through, attributed, and never answered.** A
  source's `InputRequiredResult` whose input requests are all URL mode goes back
  to the outside caller as an `InputRequiredResult` with the same `url`, and a
  `message` that names the connector it came from before the source's own text.
  The outside client attributes the request to this host, so the host says
  whose it is: a connector cannot put its page in front of a person under the
  host's name. The runtime never opens, fetches, or accepts a URL itself.
- **The source's `requestState` stays here.** The runtime holds it under an
  opaque handle stamped with the same owner context a task handle carries
  (identity, workspace, source) and the call's tool name and argument digest,
  and gives the outside caller only the handle. On the retry it resolves the
  handle under the task handles' owner check (`ownerMatches`,
  `src/tools/mcp-source.ts`), refuses one presented by a different owner or for
  a different tool or arguments, and retries the source's call with the caller's
  `inputResponses` and the source's own state. An outside client cannot forge or
  swap the state the source reads.
- **Anything else is unchanged.** A form-mode request, a sampling or roots
  request, or any input request on a call that did not claim URL mode still
  fails as it does today. A server that wants confirmation from a caller that
  cannot show a URL returns the URL in an ordinary result, or a view.
- **The confirmation page belongs to the server, behind the server's own
  sign-in.** The server binds the request to the identity it was made for. URL
  mode carries a person to that page; it never authenticates anyone, and a
  server never treats the client's `accept` as the confirmation: `accept` means
  the person agreed to open the link, nothing more.

## Consequences

- A tool that needs a person's confirmation works the same way through every
  client: a view's app-only button where views render, a URL request where the
  client claims URL mode on an inline call, and a link in the result everywhere
  else. The server owns one confirmation check, whichever way the person
  arrives.
- A tool that runs as a task does not get the relay. A server that needs a
  person's confirmation before long work asks for it on an inline call and
  starts the work after.
- The runtime's own chat still cannot answer an input request. A server that
  wants a click from it returns a view. ADR-0023's reasoning stands for form
  mode, sampling, and every unattended run.
- The host keeps per-call relay state with an expiry, which is new state on the
  `/mcp` door. An expired handle fails the retry, and the server's own page still
  holds the person's confirmation, so the caller calls again.
- Clients differ in how they treat URL requests. Some ask before opening; some
  decline them silently under a no-prompt policy. A declined request returns to
  the server as `decline`, and the server answers with its fallback, so a
  silent decline costs a click, not the action.
- The server cannot tell whether the outside client showed the URL faithfully.
  That is why the confirmation lives on the server's page, behind its sign-in,
  and never in the client's answer.
- The relay is worth building only once an outside client is seen to claim
  `elicitation.url` on a `2026-07-28` request to `/mcp`. Claude Code documents
  that claim; implementation starts by confirming it against this host.
- ADR-0023 gains its amendment note when this is accepted and implemented, in
  the same change as the code.

## Alternatives considered

- **Keep claiming nothing and let servers return a link** — rejected: it works,
  but a client that renders URL requests as a consent prompt loses that prompt,
  and every server reinvents how to say "open this" in prose.
- **Answer form mode as well** — rejected: form mode needs a person behind the
  call, and its answer comes from the client, so it proves nothing to the server.
- **Pass the source's `requestState` through to the outside caller** — rejected:
  the outside client could replay or alter state the source trusts.
- **Seal the source's `requestState` and hand it to the caller** — rejected: it
  keeps the host stateless, but a sealed blob is replayable for its lifetime by
  whoever holds it, and binding it to the owner means re-deriving the owner
  check the task handles already make.
- **Relay only first-party sources' requests** — rejected: it needs a trust
  class the runtime does not have, and naming the connector in the message
  closes the attribution gap for every source.
- **Claim URL mode on every call and render the link in chat** — rejected: the
  runtime's own chat has views for this, and an unattended run has no one to
  show a link to; claiming it there is the "advertise and fail" ADR-0023 rejects.
