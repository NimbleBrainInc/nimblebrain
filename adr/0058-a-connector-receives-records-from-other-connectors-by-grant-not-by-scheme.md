# 0058. A connector receives records from other connectors by grant, not by scheme

- Status: Proposed
- Date: 2026-10-28
- Serves: orchestrate remote MCP, secure RBAC
- Amends: the `ai.nimblebrain/resource-arguments` extension (a declared argument's scheme list becomes optional)

## Context

A connector often needs a fact that another connector in the workspace owns. An
outbound connector should refuse to draft for an account the team scored too
low, and the score lives in the workspace's CRM: a People organization, a
Salesforce account, a HubSpot company. Which CRM holds it is the workspace's
choice, and a workspace may hold accounts in more than one.

MCP gives a server no way to read another server. A server-to-host request for a
resource exists only in the 2025-era protocol; the 2026 revision removes
server-to-client requests, and `ai.nimblebrain/host-resources` serves only
`files`. What works on both eras is `ai.nimblebrain/resource-arguments`: a tool
names the arguments that hold URIs, the host reads each URI from a connector in
the calling workspace before the call, and the contents arrive in the request's
`_meta`. The receiving server gets the record the source served, not a value the
model typed, so the model can point at a record but cannot forge it.

That extension requires each argument to list the schemes it accepts, with no
wildcard. The list is the only place a server names another server's namespace,
so it ends up in one of two wrong homes: written into the server, which then
knows its peers and works with one CRM; or read from deployment configuration,
which someone must set per installation before the feature does anything. A
second copy of the data does not help either. Pushing a score into the consumer
makes two sources of truth, and a shared "account fit" shape does not exist in
Salesforce or HubSpot, whose fields are each workspace's own.

The scheme list does two jobs. It says which records the tool may receive
(permission), and it implies what those records are (meaning). The host can own
the first, and the agent already knows the second.

## Decision

**Permission is a grant to the receiving connector, not a list of schemes.** A
tool may declare a record argument with no `schemes`:

```json
{ "ai.nimblebrain/resource-arguments": { "arguments": { "account": { "records": true } } } }
```

The host resolves such an argument only for a connector the workspace has
granted record arguments. The grant is part of installing the connector: its
manifest says it accepts records, the install shows that once, and installing it
grants it. An admin can revoke the grant or narrow it to named source connectors.
A connector without the grant gets each URI in a schemeless argument back as a
refusal entry, as an undeclared URI is today. A declaration with `schemes` keeps
its current meaning and needs no grant, so the host-owned `files` scheme and
every existing tool are unchanged.

**Resolution is the reach the agent already has.** The host still resolves only
against connectors of the calling workspace, narrowed to what the caller could
read itself, under the same per-URI, per-call and rate limits. A grant adds no
source: the receiving connector sees only a record the agent passed it, never a
listing or a search, and only a record the agent could have read with
`nb__read_resource`.

**Meaning is an argument the agent fills.** A tool that needs one fact from the
record takes a second argument naming it (`lead_score`, `Lead_Score__c`,
`hs_lead_status`), and reads that field from the contents the host delivered.
The agent learns the field from the workspace's skill or the source's
`describe_fields`, as it does for any other call. The host reads no field and
keeps no mapping.

Worked example: the agent calls the outbound connector's `draft_email` with
`account: "people://organizations/123"` and `score_field: "lead_score"`. The host
reads the organization from People and delivers it with the call. The connector
reads `lead_score` from it, stores the value on the enrollment, and refuses below
its threshold. A workspace on Salesforce passes its account URI and
`Lead_Score__c`; nothing is configured in either case.

## Consequences

- A connector that needs another system's data installs and works, in any
  workspace, against whichever source holds the record. The receiving server
  names no peer and reads no deployment setting for it.
- The source stays the one copy. A score changed in the CRM is what the next call
  sees.
- A source must serve its records as resources, through resource templates, to
  be referenced this way. A connector that only has tools cannot be a source until
  it publishes templates.
- The field the agent names is a choice, not a fact: the agent can name the wrong
  field. The value it names cannot be forged, and the receiving connector records
  which field it read so a wrong choice is visible.
- The grant becomes the review point for which connectors receive records. A
  prompt-injected agent can still pass a record to a granted connector, as it can
  already pass any text it read; the grant bounds that to connectors someone
  installed knowing they accept records.
- `ai.nimblebrain/resource-arguments` gains the `records` form and the grant; its
  documentation drops the advice to keep a scheme list in configuration.

## Alternatives considered

- **A scheme list in the server** — rejected: the server names its peers and
  works with one source.
- **A scheme list in deployment configuration** — rejected: per-installation
  setup before the feature works, and a per-workspace setting to keep right for
  every source a workspace adds.
- **A workspace map from record kind to source** — rejected: the same
  configuration, owned by the workspace instead of the deployment.
- **Schemeless arguments with no grant** — rejected: any connector could receive
  any record the agent can read, with nothing an admin approved.
- **Server-to-host reads** — rejected: 2025-era only, and the 2026 protocol
  removes the request.
- **Copying the fact into the receiving connector** — rejected: a second source
  of truth that drifts from the CRM.
- **A standard record shape every source maps to** — rejected: sources do not
  share one, and their fields are each workspace's own.
