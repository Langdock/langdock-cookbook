# googlemaps-mcp-server

An MCP (Model Context Protocol) server for **Google Maps** with an interactive map UI.

It exposes tools for searching places, fetching place details, getting directions, and geocoding — and can render the results on an embedded, interactive Google Map right inside the client.

Authentication is optional: the MCP endpoint works with just a Google Maps API key. If you also configure Google OAuth credentials, the server acts as an OAuth 2.0 proxy with Dynamic Client Registration (DCR), delegating user sign-in to Google.

![Google Maps MCP interactive map](./screenshot.png)

## OAuth Flow (optional)

When `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set, MCP clients authenticate through this server, which delegates to Google for user authentication:

```
MCP Client                    This Server                    Google
    │                              │                           │
    ├─ Discover OAuth metadata ──► │                           │
    │  (/.well-known/oauth-        │                           │
    │   authorization-server)      │                           │
    │                              │                           │
    ├─ Register via DCR ─────────► │                           │
    │  (POST /register)            │                           │
    │                              │                           │
    ├─ Authorize (with PKCE) ────► │                           │
    │  (GET /authorize)            ├─ Redirect to Google ────► │
    │                              │  (accounts.google.com/    │
    │                              │   o/oauth2/v2/auth)        │
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
    │                              │  Google tokens            │
    │                              │  (oauth2.googleapis.com/  │
    │                              │   token)                  │
    │                              │                           │
    ├─ Use token for MCP ────────► │                           │
    │  (POST /mcp)                 │                           │
    │                              │                           │
```

Without OAuth credentials configured, the `/mcp` endpoint is open and only requires the server's `GOOGLE_MAPS_API_KEY` to call the Maps APIs.

## Prerequisites

- Node.js 18+
- pnpm
- A [Google Maps Platform](https://console.cloud.google.com/google/maps-apis) API key with these APIs enabled:
  - Places API
  - Directions API
  - Geocoding API
  - Maps JavaScript API (for the interactive map UI)
- _(Optional, for OAuth)_ A Google OAuth 2.0 Client (Web application) with:
  - Authorized redirect URI set to `<BASE_URL>/oauth/callback`
  - Scopes: `openid`, `profile`, `email`

## Setup

1. Clone and install:

```bash
git clone https://github.com/niklasmeixner-langdock/googlemaps-mcp-server.git
cd googlemaps-mcp-server
pnpm install
```

2. Configure environment:

```bash
export GOOGLE_MAPS_API_KEY="your-maps-api-key"
export BASE_URL="http://localhost:3000"
# Optional — enables the OAuth proxy:
# export GOOGLE_CLIENT_ID="your-oauth-client-id"
# export GOOGLE_CLIENT_SECRET="your-oauth-client-secret"
```

3. Build and run:

```bash
pnpm dev
```

The server starts on port `3000` and exposes the MCP endpoint at `/mcp`.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | Yes | Google Maps Platform API key used for all Maps API calls and the map UI |
| `PORT` | No | Port to listen on (default: `3000`) |
| `BASE_URL` | No | Public base URL of this server. Required for OAuth; auto-detected on Railway via `RAILWAY_PUBLIC_DOMAIN` |
| `GOOGLE_CLIENT_ID` | No | Google OAuth client ID — set to enable the optional OAuth proxy |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth client secret — set to enable the optional OAuth proxy |

## Endpoints

| Endpoint | Description |
|---|---|
| `/mcp` | MCP endpoint (GET, POST, DELETE) — no auth required |
| `/health` | Health check |
| `/.well-known/oauth-authorization-server` | OAuth 2.0 authorization server metadata (when OAuth is enabled) |
| `/register` | Dynamic Client Registration (RFC 7591) |
| `/authorize` | Authorization endpoint (redirects to Google) |
| `/token` | Token endpoint |
| `/oauth/callback` | Google OAuth callback |

## MCP Tools

### `search_places`

Search Google Maps for places (restaurants, hotels, landmarks, etc.).

**Parameters:** `query` (required), `location_lat`, `location_lng`, `radius` (meters, max 50000), `type` (e.g. `restaurant`, `hotel`, `museum`)

### `get_place_details`

Get detailed information about a specific place, including reviews, opening hours, and contact info.

**Parameters:** `place_id` (required) — the `place_id` from a search result

### `get_directions`

Get directions between two locations.

**Parameters:** `origin` (required), `destination` (required), `mode` (`driving` | `walking` | `bicycling` | `transit`), `waypoints`, `avoid` (`tolls`, `highways`, `ferries`)

### `geocode`

Convert an address to coordinates, or coordinates to an address (reverse geocoding).

**Parameters:** `address` _or_ `lat` + `lng`

### `render_map`

Display an interactive Google Map. Shows search results as markers, directions as routes, or a single place's details. Call `search_places` or `get_directions` first, then pass the results here to visualize them.

**Parameters:** `center_lat`, `center_lng`, `zoom` (1–20), `places`, `directions`, `place_details`, `geocode_results`

## Resources

### `ui://googlemaps/map`

The interactive map UI rendered by the `render_map` tool, served as an MCP App resource.

## Client Configuration

```json
{
  "mcpServers": {
    "googlemaps": {
      "type": "streamable-http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

For a deployed server, replace the URL with your public endpoint, e.g. `https://your-app.up.railway.app/mcp`.

## Deployment

The server is Railway-ready: when `RAILWAY_PUBLIC_DOMAIN` is present, `BASE_URL` is detected automatically, so you only need to set `GOOGLE_MAPS_API_KEY` (and the optional OAuth credentials). On any other host, set `BASE_URL` to your server's public URL.

> **Note:** OAuth client and session state is held in memory. For production, back it with a persistent store (e.g. Redis or PostgreSQL) so it survives restarts.
