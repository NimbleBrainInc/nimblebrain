# 0059. A record opens in the view its template names

- Status: Accepted
- Date: 2026-11-02
- Serves: orchestrate remote MCP
- Amends: [ADR-0052](./0052-a-view-opens-what-it-names-by-uri.md) (which view of an app a served resource opens in)

## Context

ADR-0052 opens a record URI in the one app whose server advertises a resource
template the URI expands from, and hands the app the URI as
`ai.nimblebrain/navigate`. It opens that app at its first view: the server's
highest-priority placement.

An app with several sidebar views keeps each kind of record in one of them: an
outreach app's campaigns and the leads in them under its Campaigns view, while
its first view is a dashboard. Opened at the first view, the record either
renders under the wrong section, so the breadcrumb and the sidebar disagree
about where the person is, or the app has to send it on to the right view,
which it cannot: a view can open its sibling views only at their home.

Which view shows a kind of record is a fact about the record's shape, and the
server already states every record shape it serves as a template. A second list
on the placement would state the template strings twice, in the manifest and in
the catalog generated from it, and drift silently.

## Decision

**A resource template may name the view that shows its records, in its `_meta`
under `ai.nimblebrain/view`, as the `resourceUri` of one of the server's own
placements.** The host reads it live from `resources/templates/list`, with the
template.

**The resolver opens a served resource at that view.** When the matching
template names one of the claiming server's openable views, the record opens
there; otherwise it opens at the server's first view, as before. The rest of
ADR-0052 stands: ownership by template, two claimants refused, the URI handed
over as `ai.nimblebrain/navigate`.

**A template names a view among its own server's views only.** The value is
untrusted server data, so it can choose where a server's records open within
that server's own app, and a value naming another server's placement, or none,
is ignored. No server can send a record into another app.

## Consequences

- An app routes each kind of record to the view that owns it with one key on the
  template it already serves: no manifest or catalog change, and nothing to
  deploy in lockstep.
- A server that names no view behaves exactly as under ADR-0052.
- The key reaches only the resolver. `ResourceTemplateInfo.view` is not shown to
  the model.
