# sample-mcp-sap-btp-destination

A sample MCP (Model Context Protocol) server demonstrating **SAP BTP XSUAA** OAuth 2.0 with Dynamic Client Registration (DCR) and target resolution / token exchange through the **SAP BTP Destination Service**.

MCP clients authenticate through this server using SAP BTP XSUAA. When a tool is called, the server queries the bound **SAP BTP Destination Service** (`destination` service, `lite` plan) to resolve the target URL and authentication headers—supporting both technical destinations (`NoAuthentication`, `BasicAuthentication`, `OAuth2ClientCredentials`) and user-propagated destinations (`OAuth2JWTBearer`, `OAuth2SAMLBearerAssertion`, `OAuth2UserTokenExchange` via `X-user-token`).

## Flow

```
MCP Client                This Server (on BTP)      BTP Destination Service       Target System
    │                              │                           │                        │
    ├─ Discover & Register (DCR) ─►│                           │                        │
    ├─ Authorize via XSUAA ───────►│                           │                        │
    │◄─ Issue MCP access token ────┤                           │                        │
    │                              │                           │                        │
    ├─ Call tool (POST /mcp) ─────►├─ 1. Client-credentials ──►│                        │
    │                              │     token for Destination │                        │
    │                              │     Service               │                        │
    │                              ├─ 2. GET /destination-     │                        │
    │                              │     configuration/v1/     │                        │
    │                              │     destinations/{name}   │                        │
    │                              │     (+ X-user-token for   │                        │
    │                              │      user propagation)   ─►                        │
    │                              │◄─ 3. destinationConfig + ─┤                        │
    │                              │      authTokens[]         │                        │
    │                              ├─ 4. Request target with ──────────────────────────►│
    │                              │     resolved URL & header                          │
```

## Prerequisites

- Node.js 20+
- pnpm
- Cloud Foundry CLI (`cf8`)
- An SAP BTP Subaccount with the **Cloud Foundry Runtime** enabled and entitlements for:
  - **Authorization and Trust Management Service (`xsuaa`, `application` plan)**
  - **Destination Service (`destination`, `lite` plan)**

## Deploy to SAP BTP Cloud Foundry

1. Log in to your SAP BTP Cloud Foundry space:

```bash
cf login -a https://api.cf.<region>.hana.ondemand.com --sso
```

2. Create the `xsuaa` and `destination` service instances:

```bash
cf create-service xsuaa application mcp-xsuaa -c xs-security.json
cf create-service destination lite mcp-destination
```

3. Configure an HTTP destination in the **SAP BTP Cockpit** (**Connectivity → Destinations → Create Destination**), for example `ServiceNowPDI` pointing to `https://dev12345.service-now.com`.

4. Install dependencies, build, and push:

```bash
pnpm install
pnpm run build
cf push
```

When deployed on Cloud Foundry, the server automatically reads both `xsuaa` and `destination` credentials from `VCAP_SERVICES` and detects its public route URL from `VCAP_APPLICATION`.

## Local Development

To run locally against your SAP BTP services, create service keys and copy the credentials into `.env`:

```bash
cf create-service-key mcp-xsuaa local-key
cf service-key mcp-xsuaa local-key

cf create-service-key mcp-destination local-key
cf service-key mcp-destination local-key
```

```bash
cp .env.example .env
# Fill in XSUAA_* and DESTINATION_* from the service keys
pnpm dev
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `XSUAA_URL` | Local only | XSUAA base URL (`vcap.xsuaa[0].credentials.url`) |
| `XSUAA_CLIENT_ID` | Local only | XSUAA client ID (`vcap.xsuaa[0].credentials.clientid`) |
| `XSUAA_CLIENT_SECRET` | Local only | XSUAA client secret (`vcap.xsuaa[0].credentials.clientsecret`) |
| `DESTINATION_URI` | Local only | Destination service REST URI (`vcap.destination[0].credentials.uri`) |
| `DESTINATION_AUTH_URL` | Local only | Destination service OAuth URL (`vcap.destination[0].credentials.url`) |
| `DESTINATION_CLIENT_ID` | Local only | Destination service client ID (`vcap.destination[0].credentials.clientid`) |
| `DESTINATION_CLIENT_SECRET` | Local only | Destination service client secret (`vcap.destination[0].credentials.clientsecret`) |
| `DEFAULT_DESTINATION_NAME` | No | Default BTP destination name when `destinationName` is omitted (default: `ServiceNowPDI`) |
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

### `resolve-btp-destination`

Resolves a named destination from the SAP BTP Destination Service and optionally executes a `GET` request against a relative path on that destination using the resolved `authTokens` header.

**Parameters:**
- `destinationName` (optional) — Name of the configured SAP BTP destination (defaults to `DEFAULT_DESTINATION_NAME`).
- `path` (optional) — Relative path to request on the resolved destination URL (e.g. `/api/now/table/incident?sysparm_limit=1` or `/sap/opu/odata/...`).
- `forwardUserToken` (optional) — When `true`, sends the authenticated user's XSUAA JWT in the `X-user-token` header so SAP BTP performs principal propagation / user token exchange (`OAuth2JWTBearer`, `OAuth2SAMLBearerAssertion`, `OAuth2UserTokenExchange`).

## Client Configuration

```json
{
  "mcpServers": {
    "sap-btp-destination": {
      "type": "streamable-http",
      "url": "https://<your-btp-route>.cfapps.<region>.hana.ondemand.com/mcp"
    }
  }
}
```
