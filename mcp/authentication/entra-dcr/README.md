# sample-mcp-entra-auth

A sample MCP (Model Context Protocol) server demonstrating **Microsoft Entra ID** (Azure AD) OAuth integration with Dynamic Client Registration (DCR).

This server acts as an OAuth 2.0 proxy: MCP clients authenticate through this server, which delegates to Microsoft Entra ID for user authentication and forwards the Entra access token to make Microsoft Graph API calls on behalf of the user.

## OAuth Flow

```
MCP Client                    This Server                  Entra ID
    │                              │                           │
    ├─ Discover OAuth metadata ──► │                           │
    │  (/.well-known/oauth-        │                           │
    │   authorization-server)      │                           │
    │                              │                           │
    ├─ Register via DCR ─────────► │                           │
    │  (POST /register)            │                           │
    │                              │                           │
    ├─ Authorize (with PKCE) ────► │                           │
    │  (GET /authorize)            ├─ Redirect to Entra ID ──► │
    │                              │  (/oauth2/v2.0/authorize) │
    │                              │                           │
    │                              │  ◄── User authenticates ──┤
    │                              │                           │
    │                              │  ◄── Callback with code ──┤
    │                              │  (GET /entra/callback)    │
    │                              │                           │
    │                              ├─ Exchange code for ──────►│
    │                              │  Entra tokens             │
    │                              │  (POST /oauth2/v2.0/token)│
    │                              │                           │
    │  ◄── Redirect with code ─────┤                           │
    │                              │                           │
    ├─ Exchange code for token ──► │                           │
    │  (POST /token)               │                           │
    │                              │                           │
    ├─ Use token for MCP ────────► │                           │
    │  (POST /mcp)                 ├─ Call Microsoft Graph ───►│
    │                              │                           │
```

## Prerequisites

- Node.js 18+
- pnpm
- A Microsoft Entra ID (Azure AD) app registration with:
  - Client ID and Client Secret
  - Redirect URI set to `http://localhost:3333/entra/callback`
  - `User.Read` delegated permission (Microsoft Graph)

## Setup

1. Clone and install:

```bash
git clone https://github.com/niklasmeixner-langdock/sample-mcp-entra-auth.git
cd sample-mcp-entra-auth
pnpm install
```

2. Configure environment:

```bash
cp .env.example .env
# Edit .env with your Entra ID credentials
```

3. Run:

```bash
pnpm dev
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ENTRA_TENANT_ID` | Yes | Your Azure AD tenant ID |
| `ENTRA_CLIENT_ID` | Yes | Entra ID app registration client ID |
| `ENTRA_CLIENT_SECRET` | Yes | Entra ID app registration client secret |
| `SERVER_URL` | No | Server URL (default: `http://localhost:3333`) |
| `PORT` | No | Port number (default: `3333`) |

## Endpoints

| Endpoint | Description |
|---|---|
| `/.well-known/oauth-authorization-server` | OAuth 2.0 authorization server metadata |
| `/register` | Dynamic Client Registration (RFC 7591) |
| `/authorize` | Authorization endpoint (redirects to Entra ID) |
| `/token` | Token endpoint |
| `/entra/callback` | Entra ID OAuth callback |
| `/mcp` | MCP endpoint (POST, GET, DELETE) |

## MCP Tools

### `get-current-user`

Returns the authenticated user's profile from Microsoft Graph.

**Response fields:** `id`, `displayName`, `mail`, `userPrincipalName`, `jobTitle`

## Client Configuration

```json
{
  "mcpServers": {
    "entra-auth-sample": {
      "type": "streamable-http",
      "url": "http://localhost:3333/mcp"
    }
  }
}
```
