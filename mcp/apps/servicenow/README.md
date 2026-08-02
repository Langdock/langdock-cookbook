# servicenow-mcp-server

An MCP (Model Context Protocol) server for **ServiceNow** with interactive, in-chat UI for both **creating** and **working** records.

It can:

- Inspect a ServiceNow table's fields and render an editable **creation form** right inside the client (optionally pre-filled from the conversation), then submit it as a new record. As the user types into short description / description, the form **suggests related knowledge articles** (an approximation of ServiceNow Contextual Search) so they can open a fix before filing a ticket.
- **Discover tickets** across task-derived records using user-facing filters such as state, severity, impact, assignment, and date ranges — without asking the user to identify a ServiceNow table — then open any result in the interactive ticket panel.
- **Open an existing record** (e.g. an incident) as an interactive **ticket panel** inside the client, where users can edit fields, change state, upload/download/delete attachments, and add comments or work notes — each change saved straight back to ServiceNow without leaving the chat.

The server acts as an OAuth 2.0 proxy with Dynamic Client Registration (DCR): MCP clients authenticate through this server, which delegates user sign-in to your ServiceNow instance and forwards the ServiceNow access token on every API call.

The ticket panel is **generic but ticket-aware**: it works for any table, and for tables that extend `task` (incident, `sc_task`, change, problem, …) it adds ticket-specific niceties — a state badge, an activity/journal stream, and a comment/work-note composer.

> **ServiceNow instance compatibility:** The discovery filters and interactive ticket fields in this recipe are configured for a standard ServiceNow Personal Developer Instance. They can be adapted to any ServiceNow instance, but teams adopting the recipe may need to customize its table and field mappings, choice values, and permissions to match their instance.

## OAuth Flow

MCP clients authenticate through this server, which delegates to ServiceNow for user authentication:

```
MCP Client                    This Server                  ServiceNow
    │                              │                           │
    ├─ Discover OAuth metadata ──► │                           │
    │  (/.well-known/oauth-        │                           │
    │   authorization-server)      │                           │
    │                              │                           │
    ├─ Register via DCR ─────────► │                           │
    │  (POST /register)            │                           │
    │                              │                           │
    ├─ Authorize (with PKCE) ────► │                           │
    │  (GET /authorize)            ├─ Redirect to ServiceNow ► │
    │                              │  (/oauth_auth.do)         │
    │                              │                           │
    │                              │  ◄── User authenticates ──┤
    │                              │                           │
    │                              │  ◄── Callback with code ──┤
    │                              │  (GET /oauth/callback)    │
    │                              │                           │
    │  ◄── Redirect with code ─────┤                           │
    │                              │                           │
    ├─ Exchange code for token ──► │                           │
    │  (POST /token)               ├─ Exchange code for ──────►│
    │                              │  ServiceNow tokens        │
    │                              │  (POST /oauth_token.do)   │
    │                              │                           │
    ├─ Use token for MCP ────────► │                           │
    │  (POST /mcp)                 ├─ Call ServiceNow Table ──►│
    │                              │  API                      │
    │                              │                           │
```

ServiceNow enforces PKCE, so the server sets `skipLocalPkceValidation` and lets ServiceNow validate the `code_verifier`.

## Prerequisites

- Node.js 18+
- pnpm
- A ServiceNow instance with an **OAuth API endpoint for external clients** (**System OAuth → Application Registry**):
  - Redirect URL set to `<BASE_URL>/oauth/callback`
  - Client ID (and Client Secret, for confidential clients)

## Setup

1. Install:

```bash
pnpm install
```

2. Configure environment:

```bash
export SERVICENOW_INSTANCE="dev12345"            # subdomain or full host (dev12345.service-now.com)
export SERVICENOW_CLIENT_ID="your-client-id"
export BASE_URL="http://localhost:3000"          # public URL; must match the OAuth redirect URL
# Optional — language used for form choice options (default: en):
# export SERVICENOW_LANGUAGE="en"
# Optional — maximum records inspected for cross-table choice filters:
# export SERVICENOW_DISCOVERY_SCAN_LIMIT="5000"
# Optional — only for confidential OAuth clients:
# export SERVICENOW_CLIENT_SECRET="your-client-secret"
```

3. Build and run:

```bash
pnpm dev
```

The server starts on port `3000` and exposes the MCP endpoint at `/mcp`.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SERVICENOW_INSTANCE` | Yes | Instance subdomain (`dev12345`) or full host (`dev12345.service-now.com`) |
| `SERVICENOW_CLIENT_ID` | Yes | OAuth client ID from the ServiceNow Application Registry |
| `BASE_URL` | Yes | Public base URL of this server; used to build the OAuth callback URL |
| `SERVICENOW_CLIENT_SECRET` | No | OAuth client secret — set only for confidential clients |
| `SERVICENOW_LANGUAGE` | No | Language used for form choice options (default: `en`) |
| `SERVICENOW_DISCOVERY_SCAN_LIMIT` | No | Maximum candidate records inspected for cross-table choice filters (default: `5000`) |
| `PORT` | No | Port to listen on (default: `3000`) |

## Endpoints

| Endpoint | Description |
|---|---|
| `/.well-known/oauth-authorization-server` | OAuth 2.0 authorization server metadata |
| `/register` | Dynamic Client Registration (RFC 7591) |
| `/authorize` | Authorization endpoint (redirects to ServiceNow) |
| `/token` | Token endpoint |
| `/oauth/callback` | ServiceNow OAuth callback |
| `/mcp` | MCP endpoint (GET, POST, DELETE) — requires a Bearer token |
| `/health` | Health check |

## MCP Tools

### `get_form_fields`

Get the available fields for a ServiceNow table.

**Parameters:** `table` (required) — the table name, e.g. `incident`; `view` (optional) — a ServiceNow form view name.

### `render_form`

Display an interactive form to create a ServiceNow record. Fetches the table's fields and renders them as an editable form; the LLM can pre-fill values it extracted from the conversation.

When the form includes `short_description` or `description`, it debounces those fields and calls `search_knowledge` so related published articles appear while the user types. It searches the short description first and adds the description as fallback context when needed. Results appear in a sticky panel on wider screens; selecting the inline result indicator opens the same suggestions in a compact popover. Selecting an article card opens an in-app reader, while its arrow opens the original record in ServiceNow.

The reader preserves sanitized article structure such as headings, lists, links, tables, code blocks, and images. Same-instance images are fetched with the user's ServiceNow token and embedded when they are within conservative size limits. Users can move between suggestions without losing their form state.

When the OAuth user can read ServiceNow UI metadata, the form follows the configured section names and field order for the requested view. Otherwise, commonly used ticket fields and all required fields appear first, with remaining optional fields under **More fields**.

Reference fields provide autocomplete against their configured reference tables and submit the selected record's `sys_id`. Complex scripted reference qualifiers are not reproduced; when reference metadata is unavailable, the form falls back to direct `sys_id` input. Submit and Reset remain sticky on long forms.

**Parameters:** `table` (required), `prefill` (optional) — key-value pairs (string/number/boolean) used to pre-populate fields; `view` (optional) — a ServiceNow form view name.

```json
{
  "table": "incident",
  "prefill": {
    "short_description": "Laptop won't turn on",
    "urgency": "2"
  }
}
```

### `search_reference_records`

Search records by their configured ServiceNow display field for reference-field autocomplete.

**Parameters:** `table` (required), `query` (required, 1–100 chars), `limit` (optional, 1–20, default 8).

### `search_knowledge`

Search published knowledge articles (`kb_knowledge`) by free-text keywords. Used by the creation form for live suggestions; the model can also call it directly to look up articles before opening a form.

#### How this recipe searches today

The default implementation queries `kb_knowledge` through the Table API with `IR_AND_OR_QUERY`, which hits the instance's **Zing** text index for published, active articles. The app sends natural search text (after light sanitization) and preserves Zing's relevance order. Zing applies the instance's configured stop words, stemming, synonyms, field weights, and document scoring; the app only adds excerpts and highlighting for presentation.

This works out of the box on a typical Personal Developer Instance and needs no custom ServiceNow code. Tradeoffs to be aware of:

- Results depend on the Zing index being present and maintained for `kb_knowledge`. If the index is missing or AI Search has replaced Zing for knowledge, you can get empty results that look identical to “no matching articles.”
- Table API ACLs may not match portal / Contextual Search user criteria exactly — restricted knowledge bases can over- or under-appear compared with the ServiceNow UI.
- There is no language or `valid_to` filtering unless you add it.

#### Adapting search for an enterprise instance

The default is a useful starting point, not a universal production search strategy. Many organizations want suggestions to match whatever the portal already uses (Contextual Search, AI Search, knowledge-base filters, language, and user criteria).

Those native ranking APIs are server-side rather than a documented publicly callable REST surface, so the right approach is instance-specific — for example an instance-side Scripted REST wrapper, tuned Zing configuration, or a different search endpoint. Discuss options with your ServiceNow administrators and point `search_knowledge` at whatever you standardize on.

**Parameters:** `query` (required, min 3 chars), `short_description` (optional primary search text), `description` (optional fallback context), `limit` (optional, 1–10, default 5).

```json
{
  "query": "VPN disconnects on sleep",
  "limit": 5
}
```

### `get_knowledge_article`

Fetch an active, published knowledge article by `sys_id` for the creation form's in-app reader. Marked app-only so hosts do not expose the (potentially large) HTML body to the model.

**Parameters:** `sys_id` (required) — the 32-character `kb_knowledge` record ID.

### `submit_form`

Submit a record to a ServiceNow table via the Table API.

**Parameters:** `table` (required), `data` (required) — the field values for the new record.

### `get_record`

Fetch a single existing record by `sys_id` or by its human-readable number (e.g. `INC0010023`). Values come back with both raw values and display labels.

**Parameters:** `table` (required), `id` (required) — a `sys_id` or number.

### `discover_tickets`

Find tickets across the `task` hierarchy without requiring a table name. Results
are returned as inline links and rendered in an interactive list; selecting a
card opens the editable ticket panel in the same App, with a back action that
preserves the search results. A separate action opens the actual record in
ServiceNow.

Use the named filters instead of an encoded query. The tool supports the fields
shown in the ticket panel: `state`, `priority`, `impact`, `urgency`, `severity`,
`category`, `caller`, `assigned_to`, `assignment_group`, `configuration_item`,
`opened_by`, and opened/closed date ranges. It also supports ticket number,
short-description text, active status, `assigned_to_me` or
`"assigned_to": "me"` for “my tickets”, created/updated ranges, bounded result
limits, and exact-match `additional_filters` for other fields. Choice labels
such as `1 - Critical` are accepted as well as their stored values.
“My tickets” searches default to active records unless a state or explicit
`active` value is supplied.

Choice filters are checked against each record's raw value and display label,
so table-specific state values do not get mixed together. On very large result
sets, discovery reports when it reaches `SERVICENOW_DISCOVERY_SCAN_LIMIT`;
adding an assignment, date, active, or text filter narrows that scan.

For requests such as “tickets for ITIL User” where the user’s role is not
specified, use `related_user`. It matches the person across caller, opened-by,
and assignee fields while preserving all other filters. Use `caller`,
`opened_by`, or `assigned_to` only when that relationship is explicit.

Discovery defaults to a triage-oriented order: priority, impact, then oldest
opened ticket. Use `order_by` and `order_direction` to sort by priority,
severity, impact, urgency, state, or ticket dates. The rendered list can also
use `group_by` to group results by state, ticket type, or assignment group. It
uses colored ranking/state badges, relative ticket ages, and a summary of the
active filters.

```json
{
  "severity": "1 - Critical",
  "state": "Closed",
  "impact": "1 - High",
  "assigned_to": "Charlie Witherspoon",
  "limit": 25
}
```

### `render_ticket`

Open an existing record as an **interactive ticket panel** inside the client. Fetches the record, its field schema, attachments, and comment/work-note activity, then renders an editable panel. Users can edit fields, change state, upload files up to 8 MB, open/download and delete attachments, and post comments or work notes directly in the frame.

Attachment operations are available only inside the interactive panel. Upload
and delete use app-only helpers that are not exposed as model-callable MCP
tools; downloads open ServiceNow's standard attachment URL through the host.

If ServiceNow permits discovery through `task` but denies direct Table API
access to a concrete child table, the panel falls back to the parent `task`
endpoint and exposes only inherited task fields for editing.

**Parameters:** `id` (required) — a `sys_id` or number; `table` (optional) —
the tool detects the concrete task type when it is omitted.

```json
{
  "table": "incident",
  "id": "INC0010023"
}
```

### `update_record`

Update field values on an existing record via `PATCH`. Called by the ticket panel when the user saves edits, and available to the model directly.

**Parameters:** `table` (required), `sys_id` (required), `data` (required) — the field values to change.

### `add_journal_entry`

Append a **comment** (customer-visible) or **work note** (internal) to a record's activity stream, and return the refreshed activity. Called by the ticket panel's composer.

**Parameters:** `table` (required), `sys_id` (required), `field` (`comments` | `work_notes`), `text` (required).

## Resources

### `ui://servicenow/form`

The interactive creation form rendered by the `render_form` tool, served as an MCP App resource.

### `ui://servicenow/ticket`

The interactive ticket panel rendered by the `render_ticket` tool, served as an MCP App resource.

### `ui://servicenow/ticket-list`

The interactive ticket-discovery result list rendered by `discover_tickets`.

## Client Configuration

```json
{
  "mcpServers": {
    "servicenow": {
      "type": "streamable-http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

For a deployed server, replace the URL with your public HTTPS endpoint, e.g. `https://mcp.example.com/mcp`.

## Deployment

Deploy the built `dist/` to any HTTPS host and set `BASE_URL` to the server's public URL so OAuth callbacks resolve. The `/authorize` route is handled directly (before `mcpAuthRouter`) to bypass the SDK's `redirect_uri` validation, which would otherwise require persistent client storage.

> **Note:** OAuth client and session state is held in memory. For production, back it with a persistent store (e.g. Redis or PostgreSQL) so registrations and in-flight authorizations survive restarts.
