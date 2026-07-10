# servicenow-mcp-server

An MCP (Model Context Protocol) server for **ServiceNow** with interactive, in-chat UI for both **creating** and **working** records.

It can:

- Inspect a ServiceNow table's fields and render an editable **creation form** right inside the client (optionally pre-filled from the conversation), then submit it as a new record.
- **Open an existing record** (e.g. an incident) as an interactive **ticket panel** inside the client, where users can edit fields, change state, and add comments or work notes — each change saved straight back to ServiceNow without leaving the chat.

The server acts as an OAuth 2.0 proxy with Dynamic Client Registration (DCR): MCP clients authenticate through this server, which delegates user sign-in to your ServiceNow instance and forwards the ServiceNow access token on every API call.

The ticket panel is **generic but ticket-aware**: it works for any table, and for tables that extend `task` (incident, `sc_task`, change, problem, …) it adds ticket-specific niceties — a state badge, an activity/journal stream, and a comment/work-note composer.

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

**Parameters:** `table` (required) — the table name, e.g. `incident`.

### `render_form`

Display an interactive form to create a ServiceNow record. Fetches the table's fields and renders them as an editable form; the LLM can pre-fill values it extracted from the conversation.

**Parameters:** `table` (required), `prefill` (optional) — key-value pairs (string/number/boolean) used to pre-populate fields.

```json
{
  "table": "incident",
  "prefill": {
    "short_description": "Laptop won't turn on",
    "urgency": "2"
  }
}
```

### `submit_form`

Submit a record to a ServiceNow table via the Table API.

**Parameters:** `table` (required), `data` (required) — the field values for the new record.

### `get_record`

Fetch a single existing record by `sys_id` or by its human-readable number (e.g. `INC0010023`). Values come back with both raw values and display labels.

**Parameters:** `table` (required), `id` (required) — a `sys_id` or number.

### `render_ticket`

Open an existing record as an **interactive ticket panel** inside the client. Fetches the record, its field schema, and its comment/work-note activity, then renders an editable panel. Users can edit fields, change state, and post comments/work notes directly in the frame.

**Parameters:** `table` (required), `id` (required) — a `sys_id` or number.

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

For a deployed server, replace the URL with your public endpoint, e.g. `https://your-app.up.railway.app/mcp`.

## Deployment

Deploy the built `dist/` to any HTTPS host (Railway, Fly, Render, etc.) and set `BASE_URL` to the server's public URL so OAuth callbacks resolve. The `/authorize` route is handled directly (before `mcpAuthRouter`) to bypass the SDK's `redirect_uri` validation, which would otherwise require persistent client storage.

> **Note:** OAuth client and session state is held in memory. For production, back it with a persistent store (e.g. Redis or PostgreSQL) so registrations and in-flight authorizations survive restarts.
