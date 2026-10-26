# MCP Authentication on SAP BTP

Two recipes showing how to host an OAuth 2.0–protected MCP server on **SAP Business Technology Platform (SAP BTP)** with Dynamic Client Registration (DCR), and how to wire an existing MCP App (like `mcp/apps/servicenow/`) to the **SAP BTP Destination Service**:

| Recipe | Pattern | When to use |
|---|---|---|
| [`token-forwarding/`](token-forwarding/) | **Direct Token Forwarding** | The downstream API (XSUAA `/userinfo`, CAP service, API Management, or a third-party OAuth API like ServiceNow) accepts the incoming user Bearer token directly. |
| [`destination-service/`](destination-service/) | **SAP BTP Destination Service** | The downstream SAP or third-party system is configured as an **SAP BTP Destination** (`NoAuthentication`, `BasicAuthentication`, `OAuth2ClientCredentials`, `OAuth2JWTBearer`, or `OAuth2SAMLBearerAssertion`), where BTP resolves the target URL and injects or exchanges credentials per request. |

## Architecture Comparison

### 1. Direct Token Forwarding (`token-forwarding/`)

```
MCP Client                  MCP Server (on BTP)              SAP XSUAA / IdP
    │                                │                              │
    ├─ Discover & Register (DCR) ──► │                              │
    ├─ Authorize (PKCE) ───────────► ├─ Redirect (/oauth/authorize)►│
    │                                │◄─ Callback with code ────────┤
    │◄─ Redirect with MCP code ──────┤                              │
    ├─ Exchange code (/token) ─────► ├─ Exchange for IdP token ────►│
    │                                │                              │
    ├─ Call tool (POST /mcp) ──────► ├─ Forward Bearer token ──────► Downstream API
```

### 2. SAP BTP Destination Service (`destination-service/`)

```
MCP Client                  MCP Server (on BTP)         BTP Destination Service          Target System
    │                                │                             │                           │
    ├─ Authenticate via OAuth ─────► │                             │                           │
    │                                │                             │                           │
    ├─ Call tool (POST /mcp) ──────► ├─ 1. Request destination ───►│                           │
    │                                │     (optional X-user-token  │                           │
    │                                │      for user propagation)  │                           │
    │                                │◄─ 2. Target URL + resolved ─┤                           │
    │                                │      authTokens[]           │                           │
    │                                ├─ 3. Call target with ──────────────────────────────────►│
    │                                │     resolved URL / header                               │
```

## Wiring an Existing MCP App (e.g. `mcp/apps/servicenow/`) to SAP BTP

To deploy an existing MCP App such as [`mcp/apps/servicenow/`](../../apps/servicenow/) on SAP BTP Cloud Foundry and resolve the target instance URL from the **SAP BTP Destination Service**:

1. **Create the BTP Destination Service instance and configure a destination:**

```bash
cf create-service destination lite mcp-destination
```

In the **SAP BTP Cockpit** (**Connectivity → Destinations**), create an HTTP destination (for example `ServiceNowPDI` with `URL = https://dev12345.service-now.com`).

2. **Add `manifest.yml` and `.cfignore` to the MCP App folder:**

```yaml
# manifest.yml
---
applications:
  - name: servicenow-mcp
    memory: 512M
    disk_quota: 512M
    instances: 1
    buildpacks:
      - nodejs_buildpack
    command: node dist/index.js
    health-check-type: http
    health-check-http-endpoint: /health
    env:
      NODE_ENV: production
      BTP_DESTINATION_NAME: ServiceNowPDI
    services:
      - mcp-destination
```

3. **Resolve the Destination URL from `VCAP_SERVICES` at startup (or per request):**

```ts
const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
const destCreds = vcap.destination?.[0]?.credentials;
// 1. POST ${destCreds.url}/oauth/token (grant_type=client_credentials)
// 2. GET  ${destCreds.uri}/destination-configuration/v1/destinations/${process.env.BTP_DESTINATION_NAME}
// 3. Read destinationConfiguration.URL (and authTokens[0].http_header when BTP manages target auth)
```

4. **Auto-accept cached DCR `client_id` values across container restarts:**
   When using in-memory client storage on BTP, MCP clients cache the `client_id` returned by `/register` across app restarts (which may be a plain UUID or prefixed ID). Ensure `clientsStore.getClient(clientId)` reconstructs any non-empty `clientId` on `/token` and `/authorize` so reconnections and token exchanges succeed after a Cloud Foundry restage.

## Key SAP BTP Deployment Rules for MCP Servers

1. **Do not put SAP Approuter (`@sap/approuter`) in front of the MCP server.**
   SAP Approuter intercepts unauthenticated requests and redirects callers to an interactive HTML login page, which breaks MCP OAuth metadata discovery (`/.well-known/oauth-authorization-server`), Dynamic Client Registration (`/register`), and JSON-RPC calls (`/mcp`). Expose the Node.js application route directly and let the MCP server broker OAuth.
2. **Reads `VCAP_SERVICES` automatically when deployed on Cloud Foundry.**
   Both recipes read bound `xsuaa` and `destination` credentials from Cloud Foundry's `VCAP_SERVICES` environment variable automatically, and fall back to `.env` variables for local development or Kyma.
3. **Single instance (`instances: 1`) with in-memory state.**
   Like the other recipes in `mcp/authentication/`, DCR registrations and pending authorization sessions are stored in memory. Keep `instances: 1` in `manifest.yml` for demos/POCs, or back the stores with SAP BTP Redis / PostgreSQL when scaling horizontally.
