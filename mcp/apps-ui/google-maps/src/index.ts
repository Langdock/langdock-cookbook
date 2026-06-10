#!/usr/bin/env node
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { z } from "zod";

import {
  GoogleMapsOAuthProvider,
  deleteAuthorizationSession,
  getAuthorizationSession,
  storeAuthorizationSession,
} from "./oauth/provider.js";
import {
  searchPlaces,
  getPlaceDetails,
  getDirections,
  geocode,
} from "./googlemaps/client.js";
import { encodeForDataAttr } from "./utils/encodeForDataAttr.js";
import { extractCustomHeaders } from "./utils/extractCustomHeaders.js";
import { getBaseUrl } from "./utils/getBaseUrl.js";
import { getMapHtml } from "./utils/getMapHtml.js";
import { safeJsonForHtml } from "./utils/safeJsonForHtml.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// ---------------------------------------------------------------------------
// Express App Setup
// ---------------------------------------------------------------------------

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const oauthProvider = new GoogleMapsOAuthProvider();

// ---------------------------------------------------------------------------
// Health (registered first so it's never blocked by auth middleware)
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ---------------------------------------------------------------------------
// MCP Endpoint (registered before auth middleware)
// ---------------------------------------------------------------------------

app.all("/mcp", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    const customHeaders = extractCustomHeaders(req.headers);
    const server = createMcpServer(token ?? "", customHeaders);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: null,
      });
    }
  }
});

// ---------------------------------------------------------------------------
// OAuth Endpoints (only active when Google OAuth credentials are configured)
// ---------------------------------------------------------------------------

app.get("/authorize", (req: Request, res: Response) => {
  const { client_id, redirect_uri, state, code_challenge } = req.query;

  if (!client_id || !redirect_uri || !code_challenge) {
    res.status(400).json({
      error: "invalid_request",
      error_description: "Missing required parameters",
    });
    return;
  }

  const sessionId = crypto.randomUUID();

  storeAuthorizationSession(sessionId, {
    clientId: client_id as string,
    codeChallenge: code_challenge as string,
    redirectUri: redirect_uri as string,
    state: state as string | undefined,
  });

  const googleClientId = process.env.GOOGLE_CLIENT_ID;

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", googleClientId!);
  authUrl.searchParams.set("redirect_uri", `${getBaseUrl()}/oauth/callback`);
  authUrl.searchParams.set("state", sessionId);
  authUrl.searchParams.set("code_challenge", code_challenge as string);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("scope", "openid profile email");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  res.redirect(authUrl.toString());
});

// Lazy-init auth router — skipped entirely if BASE_URL is not available
let authRouterInstance: ReturnType<typeof mcpAuthRouter> | null = null;
let authRouterFailed = false;
app.use("/", (req: Request, res: Response, next) => {
  if (authRouterFailed) {
    next();
    return;
  }
  if (!authRouterInstance) {
    try {
      const base = getBaseUrl();
      authRouterInstance = mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: new URL(base),
        baseUrl: new URL(base),
        scopesSupported: ["openid", "profile", "email"],
        resourceName: "Google Maps MCP Server",
      });
    } catch {
      console.warn("OAuth auth router not initialized (BASE_URL not set). OAuth disabled.");
      authRouterFailed = true;
      next();
      return;
    }
  }
  authRouterInstance!(req, res, next);
});

app.get("/oauth/callback", (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    res.status(400).json({ error, error_description });
    return;
  }

  if (!state || typeof state !== "string") {
    res.status(400).json({ error: "missing_state" });
    return;
  }

  const session = getAuthorizationSession(state);
  if (!session) {
    res.status(400).json({ error: "invalid_state" });
    return;
  }

  const redirectUrl = new URL(session.redirectUri);
  if (code) {
    redirectUrl.searchParams.set("code", code as string);
  }
  if (session.state) {
    redirectUrl.searchParams.set("state", session.state);
  }

  deleteAuthorizationSession(state);
  res.redirect(redirectUrl.toString());
});

// ---------------------------------------------------------------------------
// MCP Server Factory
// ---------------------------------------------------------------------------

function createMcpServer(
  token: string,
  customHeaders: Record<string, string> = {},
): McpServer {
  const server = new McpServer({
    name: "googlemaps-mcp-server",
    version: "1.0.0",
  });

  const mapResourceUri = "ui://googlemaps/map";
  const apiKey = process.env.GOOGLE_MAPS_API_KEY || "";

  // Register map UI resource
  registerAppResource(
    server,
    mapResourceUri,
    mapResourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: mapResourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await getMapHtml(),
        },
      ],
    }),
  );

  // -------------------------------------------------------------------------
  // Tool: Search Places
  // -------------------------------------------------------------------------
  server.registerTool(
    "search_places",
    {
      title: "Search Places",
      description:
        "Search for places on Google Maps (restaurants, hotels, landmarks, etc.).",
      inputSchema: {
        query: z.string().describe("Search query (e.g., 'pizza near Times Square')"),
        location_lat: z
          .number()
          .optional()
          .describe("Latitude to bias results around"),
        location_lng: z
          .number()
          .optional()
          .describe("Longitude to bias results around"),
        radius: z
          .number()
          .optional()
          .describe("Search radius in meters (max 50000)"),
        type: z
          .string()
          .optional()
          .describe(
            "Place type filter (e.g., restaurant, hotel, museum, gas_station)",
          ),
      },
    },
    async ({ query, location_lat, location_lng, radius, type }) => {
      try {
        const options: {
          location?: { lat: number; lng: number };
          radius?: number;
          type?: string;
        } = {};

        if (location_lat !== undefined && location_lng !== undefined) {
          options.location = { lat: location_lat, lng: location_lng };
        }
        if (radius) options.radius = radius;
        if (type) options.type = type;

        const results = await searchPlaces(query, options);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(results.slice(0, 20), null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: String(error) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: Get Place Details
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_place_details",
    {
      title: "Get Place Details",
      description:
        "Get detailed information about a specific place including reviews, hours, and contact info.",
      inputSchema: {
        place_id: z
          .string()
          .describe("The Google Maps place_id from a search result"),
      },
    },
    async ({ place_id }) => {
      try {
        const details = await getPlaceDetails(place_id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(details, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: String(error) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: Get Directions
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_directions",
    {
      title: "Get Directions",
      description: "Get directions between two locations.",
      inputSchema: {
        origin: z
          .string()
          .describe("Starting location (address, place name, or lat,lng)"),
        destination: z
          .string()
          .describe("Destination location (address, place name, or lat,lng)"),
        mode: z
          .enum(["driving", "walking", "bicycling", "transit"])
          .optional()
          .describe("Travel mode (default: driving)"),
        waypoints: z
          .array(z.string())
          .optional()
          .describe("Optional intermediate stops"),
        avoid: z
          .array(z.string())
          .optional()
          .describe("Features to avoid: tolls, highways, ferries"),
      },
    },
    async ({ origin, destination, mode, waypoints, avoid }) => {
      try {
        const result = await getDirections(origin, destination, {
          mode,
          waypoints,
          avoid,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: String(error) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: Geocode
  // -------------------------------------------------------------------------
  server.registerTool(
    "geocode",
    {
      title: "Geocode",
      description:
        "Convert an address to coordinates or coordinates to an address (reverse geocoding).",
      inputSchema: {
        address: z
          .string()
          .optional()
          .describe("Address to geocode (provide this OR lat/lng)"),
        lat: z.number().optional().describe("Latitude for reverse geocoding"),
        lng: z.number().optional().describe("Longitude for reverse geocoding"),
      },
    },
    async ({ address, lat, lng }) => {
      try {
        let results;
        if (address) {
          results = await geocode({ address });
        } else if (lat !== undefined && lng !== undefined) {
          results = await geocode({ lat, lng });
        } else {
          return {
            content: [
              {
                type: "text" as const,
                text: "Please provide either an address or lat/lng coordinates.",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: String(error) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: Render Map (UI Tool)
  // -------------------------------------------------------------------------
  registerAppTool(
    server,
    "render_map",
    {
      title: "Render Map",
      description:
        "Display an interactive Google Map. Can show search results as markers, directions as routes, or place details. Use search_places or get_directions first, then pass results here to visualize them.",
      inputSchema: {
        center_lat: z
          .number()
          .optional()
          .describe("Map center latitude (default: 40.7128)"),
        center_lng: z
          .number()
          .optional()
          .describe("Map center longitude (default: -74.006)"),
        zoom: z
          .number()
          .optional()
          .describe("Map zoom level 1-20 (default: 12)"),
        places: z
          .array(
            z.object({
              place_id: z.string(),
              name: z.string(),
              formatted_address: z.string(),
              geometry: z.object({
                location: z.object({
                  lat: z.number(),
                  lng: z.number(),
                }),
              }),
              rating: z.number().optional(),
              user_ratings_total: z.number().optional(),
            }),
          )
          .optional()
          .describe("Array of place results from search_places to show as markers"),
        directions: z
          .any()
          .optional()
          .describe("Directions result from get_directions to show as a route"),
        place_details: z
          .any()
          .optional()
          .describe("Place details result from get_place_details to show"),
        geocode_results: z
          .array(z.any())
          .optional()
          .describe("Geocode results from geocode to show"),
      },
      _meta: { ui: { resourceUri: mapResourceUri } },
    },
    async ({
      center_lat,
      center_lng,
      zoom,
      places,
      directions,
      place_details,
      geocode_results,
    }) => {
      try {
        const center = {
          lat: center_lat ?? 40.7128,
          lng: center_lng ?? -74.006,
        };

        let type = "places";
        if (directions) type = "directions";
        else if (place_details) type = "placeDetails";
        else if (geocode_results) type = "geocode";

        const renderData: Record<string, unknown> = {
          apiKey,
          center,
          zoom: zoom ?? 12,
          type,
        };

        if (places) renderData.places = places;
        if (directions) renderData.directions = directions;
        if (place_details) renderData.placeDetails = place_details;
        if (geocode_results) renderData.geocodeResults = geocode_results;

        let html = await getMapHtml();
        html = html.replace(
          '<div class="map-container">',
          `<div class="map-container" data-schema="${encodeForDataAttr(renderData)}">`,
        );
        html = html.replace(
          "</head>",
          `<script>window.MAP_DATA = ${safeJsonForHtml(renderData)};</script></head>`,
        );

        return {
          content: [
            { type: "text", text: JSON.stringify(renderData) },
            {
              type: "resource",
              resource: {
                uri: mapResourceUri,
                mimeType: RESOURCE_MIME_TYPE,
                text: html,
              },
            },
          ],
          _meta: { "mcpui.dev/ui-initial-render-data": renderData },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: String(error) }],
          isError: true,
        };
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Google Maps MCP Server running on port ${PORT}`);
  console.log(`MCP endpoint: /mcp`);
  console.log(`Health check: /health`);
});
