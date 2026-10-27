# sample-mcp-sap-btp-token-forwarding

A sample MCP (Model Context Protocol) server demonstrating **SAP BTP XSUAA** OAuth 2.0 integration with Dynamic Client Registration (DCR) and direct Bearer token forwarding.

This server acts as an OAuth 2.0 proxy: MCP clients authenticate through this server, which delegates to SAP BTP XSUAA (Authorization and Trust Management Service) for user authentication and forwards the resulting XSUAA JWT to call downstream APIs on behalf of the user.

## OAuth Flow

```
MCP Client                    This Server (on BTP)            SAP BTP XSUAA
    │                              │                                │
    ├─ Discover OAuth metadata ──► │                                │
    │  (/.well-known/oauth-        │                                │
    │   authorization-server)      │                                │
    │                              │                                │
    ├─ Register via DCR ─────────► │                                │
    │  (POST /register)            │                                │
    │                              │                                │
    ├─ Authorize (with PKCE) ────► │                                │
    │  (GET /authorize)            ├─ Redirect to XSUAA ──────────► │
    │                              │  (/oauth/authorize)            │
    │                              │                                │
    │                              │  ◄── User authenticates ───────┤
    │                              │                                │
    │                              │  ◄── Callback with code ───────┤
    │                              │  (GET /xsuaa/callback)         │
    │                              │                                │
    │                              ├─ Exchange code for ───────────►│
    │                              │  XSUAA JWT                     │
    │                              │  (POST /oauth/token)           │
    │                              │                                │
    │  ◄── Redirect with code ─────┤                                │
    │                              │                                │
    ├─ Exchange code for token ──► │                                │
    │  (POST /token)               │                                │
    │                              │                                │
    ├─ Use token for MCP ────────► │                                │
    │  (POST /mcp)                 ├─ Forward Bearer token ────────►│
    │                              │  (GET /userinfo or SAP API)    │
```

## Prerequisites

- Node.js 20+
- pnpm
- Cloud Foundry CLI (`cf8`)
- An SAP BTP Subaccount with the **Cloud Foundry Runtime** enabled and entitlement for **Authorization and Trust Management Service (`xsuaa`, `application` plan)**

## Deploy to SAP BTP Cloud Foundry

1. Log in to your SAP BTP Cloud Foundry space:

```bash
cf login -a https://api.cf.<region>.hana.ondemand.com --sso
```

2. Create the `xsuaa` service instance using the included `xs-security.json`:

```bash
cf create-service xsuaa application mcp-xsuaa -c xs-security.json
```

3. Install dependencies, build, and push:

```bash
pnpm install
pnpm run build
cf push
```

When deployed on Cloud Foundry, the server automatically reads XSUAA credentials from `VCAP_SERVICES` and detects its public route URL from `VCAP_APPLICATION`.

> **Important:** Expose the Node.js application route directly. Do **not** place `@sap/approuter` with XSUAA authentication in front of the MCP server, as Approuter intercepts unauthenticated requests to `/.well-known/oauth-authorization-server`, `/register`, and `/mcp` with an HTML login redirect.

## Local Development

To run locally against your SAP BTP `xsuaa` instance, create a service key and copy the credentials into `.env`:

```bash
cf create-service-key mcp-xsuaa local-key
cf service-key mcp-xsuaa local-key
```

```bash
cp .env.example .env
# Fill in XSUAA_URL, XSUAA_CLIENT_ID, XSUAA_CLIENT_SECRET from the service key
pnpm dev
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `XSUAA_URL` | Local only | XSUAA base URL (`credentials.url` in `VCAP_SERVICES` / service key) |
| `XSUAA_CLIENT_ID` | Local only | XSUAA client ID (`credentials.clientid`) |
| `XSUAA_CLIENT_SECRET` | Local only | XSUAA client secret (`credentials.clientsecret`) |
| `SERVER_URL` | No | Public URL of this server (auto-detected from `VCAP_APPLICATION` on BTP; defaults to `http://localhost:3333` locally) |
| `PORT` | No | Port number (auto-set by Cloud Foundry; defaults to `3333` locally) |

## Endpoints

| Endpoint | Description |
|---|---|
| `/.well-known/oauth-authorization-server` | OAuth 2.0 authorization server metadata |
| `/register` | Dynamic Client Registration (RFC 7591) |
| `/authorize` | Authorization endpoint (redirects to SAP BTP XSUAA) |
| `/token` | Token endpoint |
| `/xsuaa/callback` | SAP BTP XSUAA OAuth callback |
| `/mcp` | MCP endpoint (POST, GET, DELETE) |
| `/health` | Health check endpoint |

## MCP Tools

### `get-current-user`

Forwards the user's XSUAA access token to `${XSUAA_URL}/userinfo` and decodes the XSUAA JWT claims to return the authenticated SAP BTP user profile.

**Response fields:** `user_id`, `user_name`, `email`, `given_name`, `family_name`, `origin`, `subaccount_id`, `scopes`

## Client Configuration

```json
{
  "mcpServers": {
    "sap-btp-token-forwarding": {
      "type": "streamable-http",
      "url": "https://<your-btp-route>.cfapps.<region>.hana.ondemand.com/mcp"
    }
  }
}
```
