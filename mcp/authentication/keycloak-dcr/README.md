# sample-mcp-keycloak-auth

A sample MCP (Model Context Protocol) server demonstrating **Keycloak** OAuth integration with Dynamic Client Registration (DCR).

This server acts as an OAuth 2.0 proxy: MCP clients authenticate through this server, which delegates to Keycloak for user authentication and forwards the Keycloak access token to make API calls on behalf of the user.

## OAuth Flow

```
MCP Client                    This Server                  Keycloak
    │                              │                           │
    ├─ Discover OAuth metadata ──► │                           │
    │  (/.well-known/oauth-        │                           │
    │   authorization-server)      │                           │
    │                              │                           │
    ├─ Register via DCR ─────────► │                           │
    │  (POST /register)            │                           │
    │                              │                           │
    ├─ Authorize (with PKCE) ────► │                           │
    │  (GET /authorize)            ├─ Redirect to Keycloak ──► │
    │                              │  (/realms/{realm}/        │
    │                              │   protocol/openid-connect │
    │                              │   /auth)                  │
    │                              │                           │
    │                              │  ◄── User authenticates ──┤
    │                              │                           │
    │                              │  ◄── Callback with code ──┤
    │                              │  (GET /keycloak/callback) │
    │                              │                           │
    │                              ├─ Exchange code for ──────►│
    │                              │  Keycloak tokens          │
    │                              │  (/realms/{realm}/        │
    │                              │   protocol/openid-connect │
    │                              │   /token)                 │
    │                              │                           │
    │  ◄── Redirect with code ─────┤                           │
    │                              │                           │
    ├─ Exchange code for token ──► │                           │
    │  (POST /token)               │                           │
    │                              │                           │
    ├─ Use token for MCP ────────► │                           │
    │  (POST /mcp)                 ├─ Call Keycloak userinfo ─►│
    │                              │                           │
```

## Prerequisites

- Node.js 18+
- pnpm
- A Keycloak server (17+ / Quarkus distribution; for legacy WildFly installs include `/auth` in `KEYCLOAK_URL`)
- An OpenID Connect client in your realm with:
  - **Client authentication** enabled (confidential client with a client secret)
  - **Standard flow** (authorization code) enabled
  - Valid redirect URI set to `http://localhost:3333/keycloak/callback`
  - Default client scopes including `openid`, `profile`, `email`

### Creating the Keycloak client

1. In the Keycloak admin console, select your realm and go to **Clients → Create client**.
2. Client type **OpenID Connect**, set a client ID (e.g. `mcp-proxy`), then **Next**.
3. Enable **Client authentication**, keep **Standard flow** checked, then **Next** and **Save**.
4. Under **Settings → Access settings**, add `http://localhost:3333/keycloak/callback` to **Valid redirect URIs**.
5. Copy the secret from the **Credentials** tab into your `.env`.

## Setup

1. Clone and install:

```bash
git clone https://github.com/niklasmeixner-langdock/sample-mcp-keycloak-auth.git
cd sample-mcp-keycloak-auth
pnpm install
```

2. Configure environment:

```bash
cp .env.example .env
# Edit .env with your Keycloak server and client credentials
```

3. Run:

```bash
pnpm dev
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `KEYCLOAK_URL` | Yes | Base URL of your Keycloak server (e.g. `https://keycloak.example.com`), without `/realms/...` |
| `KEYCLOAK_REALM` | Yes | Realm name |
| `KEYCLOAK_CLIENT_ID` | Yes | Client ID of the confidential client |
| `KEYCLOAK_CLIENT_SECRET` | Yes | Client secret (Credentials tab) |
| `SERVER_URL` | No | Server URL (default: `http://localhost:3333`) |
| `PORT` | No | Port number (default: `3333`) |

## Endpoints

| Endpoint | Description |
|---|---|
| `/.well-known/oauth-authorization-server` | OAuth 2.0 authorization server metadata |
| `/register` | Dynamic Client Registration (RFC 7591) |
| `/authorize` | Authorization endpoint (redirects to Keycloak) |
| `/token` | Token endpoint |
| `/keycloak/callback` | Keycloak OAuth callback |
| `/mcp` | MCP endpoint (POST, GET, DELETE) |

## MCP Tools

### `get-current-user`

Returns the authenticated user's profile from Keycloak's userinfo endpoint.

**Response fields:** `sub`, `name`, `email`, `email_verified`, `preferred_username`, `given_name`, `family_name`

## Client Configuration

```json
{
  "mcpServers": {
    "keycloak-auth-sample": {
      "type": "streamable-http",
      "url": "http://localhost:3333/mcp"
    }
  }
}
```

## Note on Keycloak's native DCR

Keycloak itself supports [OpenID Connect Dynamic Client Registration](https://www.keycloak.org/securing-apps/client-registration#_openid_connect_dynamic_client_registration) at `/realms/{realm}/clients-registrations/openid-connect`. In theory an MCP client could register directly with Keycloak instead of going through this proxy. In practice, anonymous registration is locked down by Keycloak's client registration policies (trusted hosts, allowed scopes) and usually requires an initial access token, which generic MCP clients cannot supply. This sample therefore implements DCR at the MCP server itself, against a single pre-configured Keycloak client, so any compliant MCP client can connect without touching your realm's registration policies.
