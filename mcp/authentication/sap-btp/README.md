# MCP Authentication on SAP BTP

Two recipes showing how to host an OAuth 2.0–protected MCP server on **SAP Business Technology Platform (SAP BTP)** with Dynamic Client Registration (DCR), delegating user authentication to **SAP XSUAA** (or SAP Cloud Identity Services) and calling downstream systems:

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
    ├─ Authenticate via XSUAA ─────► │                             │                           │
    │                                │                             │                           │
    ├─ Call tool (POST /mcp) ──────► ├─ 1. Request destination ───►│                           │
    │  (with XSUAA session token)    │     (optional X-user-token  │                           │
    │                                │      for user propagation)  │                           │
    │                                │◄─ 2. Target URL + resolved ─┤                           │
    │                                │      authTokens[]           │                           │
    │                                ├─ 3. Call target with ──────────────────────────────────►│
    │                                │     resolved auth header                                │
```

## Key SAP BTP Deployment Rules for MCP Servers

1. **Do not put SAP Approuter (`@sap/approuter`) in front of the MCP server.**
   SAP Approuter intercepts unauthenticated requests and redirects callers to an interactive HTML login page, which breaks MCP OAuth metadata discovery (`/.well-known/oauth-authorization-server`), Dynamic Client Registration (`/register`), and JSON-RPC calls (`/mcp`). Expose the Node.js application route directly and let the MCP server broker OAuth with XSUAA.
2. **Reads `VCAP_SERVICES` automatically when deployed on Cloud Foundry.**
   Both recipes read bound `xsuaa` and `destination` credentials from Cloud Foundry's `VCAP_SERVICES` environment variable automatically, and fall back to `.env` variables for local development or Kyma.
3. **Single instance (`instances: 1`) with in-memory state.**
   Like the other recipes in `mcp/authentication/`, DCR registrations and pending authorization sessions are stored in memory. Keep `instances: 1` in `manifest.yml` for demos/POCs, or back the stores with SAP BTP Redis / PostgreSQL when scaling horizontally.
