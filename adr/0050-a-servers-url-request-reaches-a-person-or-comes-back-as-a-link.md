# 0050. A server's URL request reaches a person, or comes back as a link

- Status: Accepted
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

URL-mode elicitation is the spec's answer for that case. The server hands the
client a URL; the client shows it, asks the person for consent, and opens it
outside the model's reach; the person completes the interaction on the server's
own page; the server checks its own state. On `2026-07-28` this is an
`InputRequiredResult` carrying an `elicitation/create` request with
`mode: "url"`, and the client retries the original `tools/call` with
`inputResponses` and the echoed `requestState`. Nothing blocks: the call returns
at once and the retry is the client's.

This host stands between the two ends. An outside client calls a connector's
tool through `/mcp/<wsId>`; the runtime is the server to that client and the
client to the connector, over one connection the connector shares across every
caller in the workspace. The connector cannot tell those callers apart, and the
outside client attributes everything it receives to this host, not to the
connector behind it. ADR-0023's reason for claiming no elicitation, "elicitation
has no answerer here", holds for the runtime's own turns. It does not hold for a
call made on an outside client's behalf: the answerer is that client's person,
and nothing here waits.

## Decision

**A connector call made for an outside client carries that client's side of the
protocol, on an inline call only.** The runtime relays every input request the
connector makes back to the client, names the connector in it, and holds the
client's retry to the call it was made for.

- **The claim is the caller's, per request.** A `tools/call` at `/mcp/<wsId>` to
  a connector that runs it inline sends the outside client's own client
  capabilities in that request's `_meta` envelope, in place of the runtime's.
  The connector asks for only what the client declared: form or URL
  elicitation, sampling, or roots. Nothing else claims them:
  - not a task-augmented call: a connector that advertises the tasks extension
    runs the call as a task, polled to completion, and a task's input request
    is cancelled;
  - not the runtime's own agent turns or an unattended run, which have no one to
    answer and send no caller.
- **Every input request is passed through, attributed, and never answered
  here.** A connector's `InputRequiredResult` goes back to the client as an
  `InputRequiredResult`. Each elicitation's `message`, form and URL mode alike,
  is prefixed with the connector's display name (its catalog title, else its
  server name), because the client shows it as this host's request: a connector
  cannot put a page or a question in front of a person under the host's name.
  The runtime never opens, fetches, or accepts a URL itself.
- **A root-relative URL resolves against this runtime's web origin.** A URL-mode
  `url` that starts with a single `/` is resolved against the runtime's public
  web origin (`webOrigin`), since the client has no base for it. An absolute URL,
  anything that names another host, and any URL when no origin is configured
  pass through as they are.
- **The connector's `requestState` goes to the caller sealed.** The door signs
  it inside its own `requestState` together with the tool name and a digest of
  the call's arguments, bound to the caller's identity and workspace, under a
  per-process key, valid for ten minutes. On the retry the door verifies the
  seal and refuses, with `-32602`, a state presented by another identity, at
  another workspace's URL, for another tool or other arguments, older than ten
  minutes, or minted before the runtime restarted. It then retries the
  connector's call with the client's `inputResponses` and the connector's own
  state. The client can read the state it holds; it cannot alter it or move it
  to another call.
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
  wants a click from it returns a view. ADR-0023's reasoning stands for the
  runtime's own claims and every unattended run.
- The door keeps no state between rounds: the round travels in the client's
  `requestState`. Its key is per process, so a retry that reaches another
  process, or arrives after a restart, is refused and the client calls again;
  the server's own page still holds the person's confirmation. This joins the
  blockers under "Running more than one replica" (`src/api/AGENTS.md`).
- Clients differ in how they treat URL requests. Some ask before opening; some
  decline them silently under a no-prompt policy. A declined request returns to
  the server as `decline`, and the server answers with its fallback, so a
  silent decline costs a click, not the action.
- The server cannot tell whether the outside client showed the URL faithfully.
  That is why the confirmation lives on the server's page, behind its sign-in,
  and never in the client's answer.

## Alternatives considered

- **Keep claiming nothing and let servers return a link**: rejected. It works,
  but a client that renders URL requests as a consent prompt loses that prompt,
  and every server reinvents how to say "open this" in prose.
- **Relay URL mode only**: rejected. The runtime does not answer form mode,
  sampling, or roots here; the outside client does, by its own declared
  capabilities, as the spec intends. Withholding them from a caller that
  declared them is a gateway losing features between connector and client.
- **Keep the connector's `requestState` server-side behind a handle**: rejected.
  The `/mcp/<wsId>` door holds no per-request state a second request would need
  (ADR-0048, `src/api/AGENTS.md`), and a handle table would be new state in the
  process that relayed the request, refusing every retry routed to another
  replica. The seal binds the same owner facts and costs no state.
- **Pass the connector's `requestState` through unsealed**: rejected. The
  connector shares one connection across callers and cannot tell whose state it
  minted, so another caller could replay or alter it.
- **Relay only first-party connectors' requests**: rejected. It needs a trust
  class the runtime does not have, and naming the connector in the message
  closes the attribution gap for every connector.
- **Claim URL mode on the runtime's own calls and render the link in chat**:
  rejected. The runtime's own chat has views for this, and an unattended run has
  no one to show a link to; claiming it there is the "advertise and fail"
  ADR-0023 rejects.
