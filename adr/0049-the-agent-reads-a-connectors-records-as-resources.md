# 0049. The agent reads a connector's records as resources

- Status: Accepted
- Date: 2026-10-07
- Serves: orchestrate remote MCP

## Context

A connector that keeps records (a stateful CRM server, a ticket tracker)
publishes them as MCP resources: a resource template such as
`<scheme>://contacts/{id}` in `resources/templates/list`, and the record's `uri`
on the tool results that return it. A resource is the protocol's way to hand a
client one record whole, without a tool per record type.

`nb__read_resource` already reads any URI: it asks each source in the
workspace registry in turn, so a connector's record URI resolves. The model is
not told so. The tool's description names only the schemes the host resolves
itself, and nothing in the prompt names the record shapes a connector serves,
so the model reaches for a `get_*` tool or does not read the record at all.

The tool also cuts every read at the skill budget. That budget fits a skill,
which is guidance loaded beside other context. It does not fit a record: a
contact with a long research dossier is cut partway, under a note that does
not say where the rest is. So a server keeps a `get_*` tool as the only
whole-record read, and the resource is decorative.

The prompt already carries one entry per installed connector
(`Runtime.buildAppInfo`, rendered by `formatAppsSection`): its description, its
`initialize.instructions`, and its `app://instructions` overlay, each in its own
containment tag.

## Decision

- **A connector's resource templates are named in its entry in the prompt.**
  `buildAppInfo` reads the server's `resources/templates/list` and renders it in
  an `<app-resource-templates>` containment tag under that connector, one
  `shape — name` line each, with one note at the end of the apps section saying the
  shapes are read with `nb__read_resource`. The note appears only when some
  connector lists templates.
- **The list is bounded where the prompt is assembled.** Templates in a scheme
  the host resolves itself are dropped (they are reached through their own
  mechanism), duplicates are dropped, an over-long template is dropped, and at
  most `MAX_PROMPT_RESOURCE_TEMPLATES` are kept per connector, in the server's
  order (`readableRecordTemplates`).
- **The templates are read once per connection.** `McpSource.resourceTemplates`
  fetches on first ask after a connect, under a short timeout, and keeps the
  answer, a failure included, until the next connect. A server that declares no
  `resources` capability is not asked.
- **A non-skill read returns up to the tool-result limit.** `skill://` keeps the
  skill budget. Any other read returns up to `MAX_TOOL_RESULT_CHARS` minus room
  for the note, so the engine's own bound never cuts it again. A cut read says
  how much it shows of how much, that `read_resource` returns no more, and that
  the rest is held only by the app that published it.
- **The bridge is unchanged.** An app view still reads only its own server's
  resources through its iframe. This decision is about the model's read.

## Consequences

- A server can drop a `get_*` tool that only returned a record whole: the
  template in the prompt and the `uri` on its results are enough.
- A connector's entry grows by at most the template cap, and a workspace whose
  connectors publish no templates gets the prompt it had. The list changes only
  when a connection does, so it does not churn the cached prompt prefix turn to
  turn; a server that changes its templates while connected is seen on its next
  connect.
- A record larger than the tool-result limit is still cut, and the model is told
  so. Paging a resource is not something `resources/read` offers; a server that
  needs it keeps a tool.
- A template's name is server-authored text in the prompt. It is contained and
  escaped like every other server-authored block, and line-flattened, so it
  cannot forge a sibling entry.

## Alternatives considered

- **List the templates in `nb__read_resource`'s description** — rejected: the
  description is one string for every workspace, so it grows with every
  connector installed anywhere, and the per-connector entry already exists.
- **A tool to list templates on demand** — rejected: the model has to know to
  call it, which is the problem; the entry in the prompt costs a few lines.
- **Keep one limit for every read** — rejected: a skill and a record have
  different budgets, and the record's is the one every tool result already has.
- **Page a cut read with an offset argument** — rejected: `resources/read` has
  no range, so the host would fetch the whole record per page; the cut is rare
  at the tool-result limit.
