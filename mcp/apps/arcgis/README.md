# arcgis-mcp-server

An MCP (Model Context Protocol) server for **custom ArcGIS web maps** with an interactive map UI.

Unlike a Google Maps-style pin-and-directions app, this recipe authors a real **ArcGIS Web Map**: org and Living Atlas layers, basemap, extent, simple symbology, then save to the signed-in user's portal content. Every map edit tool is an MCP App, so the host can show the updated map as soon as the model changes it.

Authentication is **ArcGIS OAuth**. The MCP endpoint uses the Bearer token as the portal user. If you also set `ARCGIS_CLIENT_ID` and `ARCGIS_CLIENT_SECRET`, the server acts as an OAuth 2.0 proxy with Dynamic Client Registration (DCR), delegating sign-in to ArcGIS Online or Enterprise.

## Why this vs Google Maps

| Google Maps MCP | This recipe |
|---|---|
| Places, directions, pins | Org feature layers and Living Atlas |
| Transient map in chat | Durable **Web Map item** in ArcGIS |
| API key | Named-user OAuth |
| Separate `render_map` after search | Map UI on `create_map`, `add_layer`, `style_layer`, `save_web_map`, … |

## OAuth flow

When `ARCGIS_CLIENT_ID` and `ARCGIS_CLIENT_SECRET` are set, MCP clients authenticate through this server, which delegates to ArcGIS:

```
MCP Client                    This Server                    ArcGIS
    │                              │                           │
    ├─ Discover OAuth metadata ──► │                           │
    ├─ Register via DCR ─────────► │                           │
    ├─ Authorize (PKCE) ─────────► │                           │
    │                              ├─ Redirect to ArcGIS ────► │
    │                              │  (/{portal}/sharing/rest/ │
    │                              │   oauth2/authorize)       │
    │                              │  ◄── User signs in ───────┤
    │                              │  ◄── Callback with code ──┤
    │  ◄── Redirect with code ─────┤                           │
    ├─ Exchange code for token ──► │                           │
    │                              ├─ Exchange with ArcGIS ──► │
    ├─ Use token for MCP ────────► │                           │
    │  (POST /mcp)                 ├─ Portal REST as user ───► │
```

Langdock can also use **manual MCP OAuth** against ArcGIS directly and send the ArcGIS access token as `Authorization: Bearer` to `/mcp`. In that case you do not need this server's DCR proxy — only a reachable `/mcp` URL.

Without a user token, map-authoring tools fail closed and ask the user to sign in.

## Prerequisites

- Node.js 18+
- pnpm
- [OAuth 2.0 developer credentials](https://developers.arcgis.com/documentation/security-and-authentication/user-authentication/tutorials/create-oauth-credentials-user-auth/online/) in ArcGIS Online or Enterprise:
  - **Content → New item → Developer credentials → OAuth 2.0 credentials** (not a generic Application / web mapping item)
  - Redirect URI `<BASE_URL>/oauth/callback`
  - Copy **Client ID** and **Client Secret** from that item's Settings. For a registered OAuth item the client id is often the same as the item id; a generic Application item has no secret.
- The connecting user must be able to create items in ArcGIS Online or Enterprise

## Setup

```bash
cd mcp/apps/arcgis
pnpm install

export ARCGIS_CLIENT_ID="your-arcgis-app-client-id"
export ARCGIS_CLIENT_SECRET="your-arcgis-app-client-secret"
export BASE_URL="http://localhost:3000"
# Optional Enterprise portal (default is ArcGIS Online):
# export ARCGIS_PORTAL_URL="https://gis.example.com/portal"

pnpm dev
```

The server starts on port `3000` and exposes MCP at `/mcp`.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Listen port (default `3000`) |
| `BASE_URL` | For DCR | Public base URL. Auto-detected on Railway via `RAILWAY_PUBLIC_DOMAIN` |
| `ARCGIS_CLIENT_ID` | For DCR | ArcGIS OAuth application client id |
| `ARCGIS_CLIENT_SECRET` | For DCR | ArcGIS OAuth application client secret |
| `ARCGIS_PORTAL_URL` | No | Portal root, default `https://www.arcgis.com`. Override per request with header `x-arcgis-portal-url` |

OAuth client and in-progress map state are in memory. For production, persist both (e.g. Redis).

## Endpoints

| Endpoint | Description |
|---|---|
| `/mcp` | MCP Streamable HTTP |
| `/health` | Health check |
| `/.well-known/oauth-authorization-server` | AS metadata (when DCR is enabled) |
| `/register` | Dynamic Client Registration |
| `/authorize` | Authorization (redirects to ArcGIS) |
| `/token` | Token endpoint |
| `/oauth/callback` | ArcGIS OAuth callback |

## MCP tools

Map-mutating tools all declare `_meta.ui.resourceUri = ui://arcgis/map`, so the host can show the map after each edit (no separate `render_map` step). Each result is a full snapshot of the current web map.

| Tool | UI | Purpose |
|---|---|---|
| `search_content` | No | Search my content / org / Living Atlas |
| `create_map` | Yes | Start a custom web map |
| `open_web_map` | Yes | Load an existing web map item |
| `add_layer` | Yes | Add a feature layer from item id or HTTPS ArcGIS URL |
| `remove_layer` | Yes | Remove a layer |
| `set_basemap` | Yes | streets, satellite, topo, dark, oceans |
| `set_extent` | Yes | WGS84 bounding box |
| `style_layer` | Yes | Simple color renderer |
| `save_web_map` | Yes | Create or update the portal Web Map item |

## Resource

`ui://arcgis/map` — interactive ArcGIS Maps SDK view of the current web map.

## Client configuration

```json
{
  "mcpServers": {
    "arcgis": {
      "type": "streamable-http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

In Langdock: add a custom MCP integration pointing at `/mcp`, auth **OAuth DCR** (this server) or **OAuth** against your ArcGIS portal (`…/sharing/rest/oauth2/authorize` and `…/token`).

## Deployment

Railway-ready: set `ARCGIS_CLIENT_ID` and `ARCGIS_CLIENT_SECRET`; `BASE_URL` is inferred from `RAILWAY_PUBLIC_DOMAIN`. Elsewhere, set `BASE_URL` to the public URL.

Layer URLs are limited to HTTPS on the portal host or `*.arcgis.com` / `*.arcgisonline.com` / `*.esri.com`.
