# servicenow-mcp-server

An MCP (Model Context Protocol) server for **ServiceNow** with an interactive record-creation UI.

It exposes tools to inspect a ServiceNow table's fields, render an editable form right inside the client (optionally pre-filled from the conversation), and submit the result as a new record. The server acts as an OAuth 2.0 proxy with Dynamic Client Registration (DCR): MCP clients authenticate through this server, which delegates user sign-in to your ServiceNow instance and forwards the ServiceNow access token on every API call.

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

## Resources

### `ui://servicenow/form`

The interactive form UI rendered by the `render_form` tool, served as an MCP App resource.

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
