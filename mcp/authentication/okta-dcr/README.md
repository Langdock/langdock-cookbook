# sample-mcp-okta-auth

A sample MCP (Model Context Protocol) server demonstrating **Okta** OAuth integration with Dynamic Client Registration (DCR).

This server acts as an OAuth 2.0 proxy: MCP clients authenticate through this server, which delegates to Okta for user authentication and forwards the Okta access token to make API calls on behalf of the user.

## OAuth Flow

```
MCP Client                    This Server                    Okta
    │                              │                           │
    ├─ Discover OAuth metadata ──► │                           │
    │  (/.well-known/oauth-        │                           │
    │   authorization-server)      │                           │
    │                              │                           │
    ├─ Register via DCR ─────────► │                           │
    │  (POST /register)            │                           │
    │                              │                           │
    ├─ Authorize (with PKCE) ────► │                           │
    │  (GET /authorize)            ├─ Redirect to Okta ──────► │
    │                              │  (/oauth2/default/v1/     │
    │                              │   authorize)              │
    │                              │                           │
    │                              │  ◄── User authenticates ──┤
    │                              │                           │
    │                              │  ◄── Callback with code ──┤
    │                              │  (GET /okta/callback)     │
    │                              │                           │
    │                              ├─ Exchange code for ──────►│
    │                              │  Okta tokens              │
    │                              │  (POST /oauth2/default/   │
    │                              │   v1/token)               │
    │                              │                           │
    │  ◄── Redirect with code ─────┤                           │
    │                              │                           │
    ├─ Exchange code for token ──► │                           │
    │  (POST /token)               │                           │
    │                              │                           │
    ├─ Use token for MCP ────────► │                           │
    │  (POST /mcp)                 ├─ Call Okta userinfo ─────►│
    │                              │                           │
```

## Prerequisites

- Node.js 18+
- pnpm
- An Okta application (Web type) with:
  - Client ID and Client Secret
  - Sign-in redirect URI set to `http://localhost:3333/okta/callback`
  - Grant types: Authorization Code, Refresh Token
  - Scopes: `openid`, `profile`, `email`

## Setup

1. Clone and install:

```bash
git clone https://github.com/niklasmeixner-langdock/sample-mcp-okta-auth.git
cd sample-mcp-okta-auth
pnpm install
```

2. Configure environment:

```bash
cp .env.example .env
# Edit .env with your Okta credentials
```

3. Run:

```bash
pnpm dev
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OKTA_DOMAIN` | Yes | Your Okta domain (e.g. `your-org.okta.com`) |
| `OKTA_CLIENT_ID` | Yes | Okta application client ID |
| `OKTA_CLIENT_SECRET` | Yes | Okta application client secret |
| `SERVER_URL` | No | Server URL (default: `http://localhost:3333`) |
| `PORT` | No | Port number (default: `3333`) |

## Endpoints

| Endpoint | Description |
|---|---|
| `/.well-known/oauth-authorization-server` | OAuth 2.0 authorization server metadata |
| `/register` | Dynamic Client Registration (RFC 7591) |
| `/authorize` | Authorization endpoint (redirects to Okta) |
| `/token` | Token endpoint |
| `/okta/callback` | Okta OAuth callback |
| `/mcp` | MCP endpoint (POST, GET, DELETE) |

## MCP Tools

### `get-current-user`

Returns the authenticated user's profile from Okta's userinfo endpoint.

**Response fields:** `sub`, `name`, `email`, `email_verified`, `preferred_username`, `locale`, `zoneinfo`

## Client Configuration

```json
{
  "mcpServers": {
    "okta-auth-sample": {
      "type": "streamable-http",
      "url": "http://localhost:3333/mcp"
    }
  }
}
```
