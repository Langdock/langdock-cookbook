# MCP Authentication on SAP BTP

Two recipes showing how to host an OAuth 2.0–protected MCP server on **SAP Business Technology Platform (SAP BTP)** with Dynamic Client Registration (DCR), and how to wire an existing MCP App (like `mcp/apps/servicenow/`) to the **SAP BTP Destination Service**:

| Recipe | Pattern | When to use |
|---|---|---|
| [`token-forwarding/`](token-forwarding/) | **Direct Token Forwarding** | The downstream API (XSUAA `/userinfo`, an SAP CAP / Rap service, SAP API Management, or a third-party API configured to trust the upstream IdP's JWT) accepts the user's Bearer token directly. |
| [`destination-service/`](destination-service/) | **SAP BTP Destination Service** | The downstream SAP or third-party system is configured as an **SAP BTP Destination** (`NoAuthentication`, `BasicAuthentication`, `OAuth2ClientCredentials`, `OAuth2JWTBearer`, `OAuth2SAMLBearerAssertion`, or `OAuth2UserTokenExchange`), where BTP resolves the target URL and injects or exchanges credentials per request. |

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
    ├─ Authenticate via XSUAA ─────► │                             │                           │
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

In the **SAP BTP Cockpit** (**Connectivity → Destinations**), create an HTTP destination with `ProxyType = Internet` (for example `ServiceNowPDI` with `URL = https://dev12345.service-now.com`).

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
      DEFAULT_DESTINATION_NAME: ServiceNowPDI
    services:
      - mcp-destination
```

And set the ServiceNow OAuth variables via `cf set-env`:

```bash
cf set-env servicenow-mcp BASE_URL https://<your-btp-route>.cfapps.<region>.hana.ondemand.com
cf set-env servicenow-mcp SERVICENOW_CLIENT_ID <your-client-id>
cf set-env servicenow-mcp SERVICENOW_CLIENT_SECRET <your-client-secret>
```

3. **Update `src/utils/getInstanceUrl.ts` to resolve the Destination URL from `VCAP_SERVICES` at startup:**

```ts
let resolvedBtpInstanceUrl: string | undefined;

export async function initBtpDestinationUrl(): Promise<void> {
  if (!process.env.VCAP_SERVICES) return;
  const vcap = JSON.parse(process.env.VCAP_SERVICES);
  const destCreds = vcap.destination?.[0]?.credentials;
  if (!destCreds?.uri || !destCreds?.url || !destCreds?.clientid || !destCreds?.clientsecret) return;

  const destinationName = process.env.DEFAULT_DESTINATION_NAME || "ServiceNowPDI";
  const basic = Buffer.from(`${destCreds.clientid}:${destCreds.clientsecret}`).toString("base64");
  const tokenRes = await fetch(`${destCreds.url.replace(/\/$/, "")}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
  });
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const destRes = await fetch(
    `${destCreds.uri.replace(/\/$/, "")}/destination-configuration/v1/destinations/${encodeURIComponent(destinationName)}`,
    { headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" } },
  );
  const destData = (await destRes.json()) as { destinationConfiguration?: { URL?: string } };
  resolvedBtpInstanceUrl = destData.destinationConfiguration?.URL?.replace(/\/$/, "");
}
```

4. **Handling cached DCR `client_id` values across container restages:**
   When using in-memory client storage on BTP, MCP clients cache the `client_id` returned by `/register` across app restarts:
   - If the server uses the SDK's `mcpAuthRouter` for `/authorize` (like the recipes in this folder), keep `clientsStore.getClient(clientId)` as a plain lookup (`this.clients.get(clientId)`) so the `/authorize` pre-middleware registers unknown clients with their `redirect_uri` intact.
   - If the server handles `/authorize` with a custom Express route before `mcpAuthRouter` (like `mcp/apps/servicenow/`), only `/token` calls `getClient(clientId)`, so `getClient` can accept any non-empty `clientId` (not just `mcp_`-prefixed IDs).

## Key SAP BTP Deployment Rules for MCP Servers

1. **Do not put SAP Approuter (`@sap/approuter`) in front of the MCP server.**
   SAP Approuter intercepts unauthenticated requests and redirects callers to an interactive HTML login page, which breaks MCP OAuth metadata discovery (`/.well-known/oauth-authorization-server`), Dynamic Client Registration (`/register`), and JSON-RPC calls (`/mcp`). Expose the Node.js application route directly and let the MCP server broker OAuth.
2. **Reads `VCAP_SERVICES` automatically when deployed on Cloud Foundry.**
   Both recipes read bound `xsuaa` and `destination` credentials from Cloud Foundry's `VCAP_SERVICES` environment variable automatically, and fall back to `.env` variables for local development.
3. **Single instance (`instances: 1`) with in-memory state.**
   Like the other recipes in `mcp/authentication/`, DCR registrations, pending authorization sessions, and active token mappings are stored in memory. Keep `instances: 1` in `manifest.yml` for demos/POCs; a container restart invalidates in-memory MCP access tokens (requiring token refresh or re-authentication). Back the stores with SAP BTP Redis / PostgreSQL when scaling horizontally.
