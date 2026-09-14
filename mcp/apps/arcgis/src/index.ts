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
  ArcgisOAuthProvider,
  deleteAuthorizationSession,
  getArcgisPortalUrl,
  getAuthorizationSession,
  storeAuthorizationSession,
} from "./oauth/provider.js";
import {
  createPortalClient,
  getPortalUrl,
  isAllowedLayerUrl,
  mapViewerUrl,
} from "./arcgis/portal.js";
import { getMapSession, saveMapSession } from "./arcgis/session.js";
import {
  ARCGIS_MAP_BASEMAPS,
  ARCGIS_MAP_UI_URI,
  addOperationalLayer,
  createEmptyWebMap,
  removeOperationalLayer,
  setBasemap,
  setExtent,
  simpleRenderer,
  styleOperationalLayer,
  summarizeSession,
  type ArcgisBasemapId,
  type ArcgisMapSession,
} from "./arcgis/webmap.js";
import { encodeForDataAttr } from "./utils/encodeForDataAttr.js";
import { extractCustomHeaders } from "./utils/extractCustomHeaders.js";
import { getBaseUrl } from "./utils/getBaseUrl.js";
import { getMapHtml } from "./utils/getMapHtml.js";
import { safeJsonForHtml } from "./utils/safeJsonForHtml.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: true }));

const oauthProvider = new ArcgisOAuthProvider();

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.all("/mcp", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";

    const customHeaders = extractCustomHeaders(req.headers);
    const server = createMcpServer(token, customHeaders);
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

  const arcgisClientId = process.env.ARCGIS_CLIENT_ID;
  const portalUrl = getArcgisPortalUrl();

  const authUrl = new URL(`${portalUrl}/sharing/rest/oauth2/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", arcgisClientId!);
  authUrl.searchParams.set("redirect_uri", `${getBaseUrl()}/oauth/callback`);
  authUrl.searchParams.set("state", sessionId);
  // PKCE stays between the MCP client and this server. Do not send it to ArcGIS.
  // -1 requests a refresh token from ArcGIS Online / Enterprise.
  authUrl.searchParams.set("expiration", "-1");

  res.redirect(authUrl.toString());
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

// Mount at startup. Creating mcpAuthRouter inside a request handler makes
// express-rate-limit throw ERR_ERL_CREATED_IN_REQUEST_HANDLER and /token 400.
try {
  const base = getBaseUrl();
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(base),
      baseUrl: new URL(base),
      scopesSupported: [],
      resourceName: "ArcGIS MCP Server",
    }),
  );
} catch {
  console.warn(
    "OAuth auth router not initialized (BASE_URL not set). OAuth disabled.",
  );
}

function requireToken(token: string): string {
  if (!token) {
    throw new Error(
      "Sign in with ArcGIS OAuth to create custom web maps from your organization's layers.",
    );
  }
  return token;
}

function requireSession(token: string): ArcgisMapSession {
  const session = getMapSession(token);
  if (!session) {
    throw new Error(
      "No map in progress. Call create_map or open_web_map first.",
    );
  }
  return session;
}

async function mapToolResult(
  token: string,
  portalUrl: string,
  session: ArcgisMapSession,
) {
  const renderData = {
    portalUrl,
    token,
    itemId: session.itemId,
    title: session.title,
    viewerUrl: session.viewerUrl,
    webmap: session.webmap,
  };

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
      { type: "text" as const, text: summarizeSession(session) },
      {
        type: "resource" as const,
        resource: {
          uri: ARCGIS_MAP_UI_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
        },
      },
    ],
    structuredContent: {
      itemId: session.itemId,
      title: session.title,
      viewerUrl: session.viewerUrl,
      basemap: session.webmap.baseMap.title,
      layers: session.webmap.operationalLayers.map((layer) => ({
        id: layer.id,
        title: layer.title,
        url: layer.url,
      })),
    },
    _meta: { "mcpui.dev/ui-initial-render-data": renderData },
  };
}

function toolError(error: unknown) {
  return {
    content: [{ type: "text" as const, text: String(error) }],
    isError: true as const,
  };
}

function createMcpServer(
  token: string,
  customHeaders: Record<string, string> = {},
): McpServer {
  const server = new McpServer({
    name: "arcgis-mcp-server",
    version: "1.0.0",
  });
  const portalUrl = getPortalUrl(customHeaders);
  const mapUi = {
    _meta: { ui: { resourceUri: ARCGIS_MAP_UI_URI } },
  };

  registerAppResource(
    server,
    ARCGIS_MAP_UI_URI,
    ARCGIS_MAP_UI_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: ARCGIS_MAP_UI_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await getMapHtml(),
        },
      ],
    }),
  );

  server.registerTool(
    "search_content",
    {
      title: "Search ArcGIS Content",
      description:
        "Search the signed-in user's ArcGIS Online / Enterprise content, org items, or Living Atlas for feature layers and web maps. Use the returned item ids with add_layer or open_web_map.",
      inputSchema: {
        query: z
          .string()
          .describe(
            'Search query, e.g. \'flood type:"Feature Service"\' or \'title:hydrants\'',
          ),
        num: z.number().optional().describe("Max results (default 10, max 25)"),
      },
    },
    async ({ query, num }) => {
      try {
        const client = createPortalClient({
          portalUrl,
          token: requireToken(token),
        });
        const results = await client.searchContent({ query, num });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(results, null, 2) },
          ],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "create_map",
    {
      title: "Create Map",
      description:
        "Start a custom ArcGIS web map. The interactive map is shown immediately and updates as you add layers, change the basemap, or set the extent. Call save_web_map to write it to the user's ArcGIS content.",
      inputSchema: {
        title: z.string().describe("Title for the web map"),
        basemap: z
          .enum(ARCGIS_MAP_BASEMAPS)
          .optional()
          .describe("Basemap: streets, satellite, topo, dark, or oceans"),
        xmin: z.number().optional().describe("Extent west longitude"),
        ymin: z.number().optional().describe("Extent south latitude"),
        xmax: z.number().optional().describe("Extent east longitude"),
        ymax: z.number().optional().describe("Extent north latitude"),
      },
      ...mapUi,
    },
    async ({ title, basemap, xmin, ymin, xmax, ymax }) => {
      try {
        requireToken(token);
        const extent =
          xmin !== undefined &&
          ymin !== undefined &&
          xmax !== undefined &&
          ymax !== undefined
            ? { xmin, ymin, xmax, ymax }
            : undefined;
        const session = saveMapSession(
          token,
          createEmptyWebMap(title, (basemap ?? "streets") as ArcgisBasemapId, extent),
        );
        return await mapToolResult(token, portalUrl, session);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "open_web_map",
    {
      title: "Open Web Map",
      description:
        "Load an existing ArcGIS web map item into the editor and display it. Subsequent add_layer / style_layer / save_web_map calls edit this map.",
      inputSchema: {
        itemId: z.string().describe("ArcGIS web map item id"),
      },
      ...mapUi,
    },
    async ({ itemId }) => {
      try {
        const client = createPortalClient({
          portalUrl,
          token: requireToken(token),
        });
        const item = await client.getItem(itemId);
        const data = await client.getItemData(itemId);
        const webmap = data as ArcgisMapSession["webmap"];
        const session = saveMapSession(token, {
          itemId: item.id,
          title: item.title,
          webmap: {
            operationalLayers: Array.isArray(webmap?.operationalLayers)
              ? (webmap.operationalLayers as ArcgisMapSession["webmap"]["operationalLayers"])
              : [],
            baseMap: webmap?.baseMap ?? createEmptyWebMap(item.title).webmap.baseMap,
            spatialReference: webmap?.spatialReference ?? { wkid: 102100 },
            version: webmap?.version ?? "2.31",
            authoringApp: webmap?.authoringApp ?? "ArcGIS MCP App",
            authoringAppVersion: webmap?.authoringAppVersion ?? "1.0.0",
            initialState: webmap?.initialState,
          },
          viewerUrl: mapViewerUrl(portalUrl, item.id),
        });
        return await mapToolResult(token, portalUrl, session);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "add_layer",
    {
      title: "Add Layer",
      description:
        "Add a feature layer to the current custom map from a search result item id or an ArcGIS feature service URL. The map UI updates immediately.",
      inputSchema: {
        itemId: z
          .string()
          .optional()
          .describe("Portal item id from search_content"),
        url: z
          .string()
          .optional()
          .describe("HTTPS feature service or feature layer URL"),
        title: z.string().optional().describe("Layer title override"),
      },
      ...mapUi,
    },
    async ({ itemId, url, title }) => {
      try {
        requireToken(token);
        const session = requireSession(token);
        const client = createPortalClient({ portalUrl, token });
        let layerUrl = url;
        let layerTitle = title;
        let layerItemId = itemId;
        let layerType = "ArcGISFeatureLayer";

        if (itemId) {
          const item = await client.getItem(itemId);
          layerUrl = item.url ?? layerUrl;
          layerTitle = layerTitle ?? item.title;
          if (item.type === "Map Service") {
            layerType = "ArcGISMapServiceLayer";
          }
        }
        if (!layerUrl) {
          throw new Error("Provide itemId or url for the layer to add.");
        }
        if (!isAllowedLayerUrl(layerUrl, portalUrl)) {
          throw new Error(
            "Layer URL must be HTTPS on the portal host or *.arcgis.com / *.arcgisonline.com / *.esri.com.",
          );
        }

        const updated = saveMapSession(
          token,
          addOperationalLayer(session, {
            id: layerItemId ?? crypto.randomUUID(),
            title: layerTitle ?? "Layer",
            url: layerUrl,
            layerType,
            itemId: layerItemId,
          }),
        );
        return await mapToolResult(token, portalUrl, updated);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "remove_layer",
    {
      title: "Remove Layer",
      description:
        "Remove an operational layer from the current custom map by layer id or title. The map UI updates immediately.",
      inputSchema: {
        layerId: z.string().describe("Layer id or title to remove"),
      },
      ...mapUi,
    },
    async ({ layerId }) => {
      try {
        requireToken(token);
        const updated = saveMapSession(
          token,
          removeOperationalLayer(requireSession(token), layerId),
        );
        return await mapToolResult(token, portalUrl, updated);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "set_basemap",
    {
      title: "Set Basemap",
      description:
        "Change the basemap of the current custom map. The map UI updates immediately.",
      inputSchema: {
        basemap: z.enum(ARCGIS_MAP_BASEMAPS),
      },
      ...mapUi,
    },
    async ({ basemap }) => {
      try {
        requireToken(token);
        const updated = saveMapSession(
          token,
          setBasemap(requireSession(token), basemap),
        );
        return await mapToolResult(token, portalUrl, updated);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "set_extent",
    {
      title: "Set Extent",
      description:
        "Set the visible extent of the current custom map (WGS84 longitudes/latitudes). The map UI updates immediately.",
      inputSchema: {
        xmin: z.number().describe("West longitude"),
        ymin: z.number().describe("South latitude"),
        xmax: z.number().describe("East longitude"),
        ymax: z.number().describe("North latitude"),
      },
      ...mapUi,
    },
    async ({ xmin, ymin, xmax, ymax }) => {
      try {
        requireToken(token);
        const updated = saveMapSession(
          token,
          setExtent(requireSession(token), { xmin, ymin, xmax, ymax }),
        );
        return await mapToolResult(token, portalUrl, updated);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "style_layer",
    {
      title: "Style Layer",
      description:
        "Apply a simple color renderer to a layer on the current custom map. The map UI updates immediately.",
      inputSchema: {
        layerId: z.string().describe("Layer id or title"),
        color: z
          .array(z.number())
          .min(3)
          .max(4)
          .describe("RGBA 0-255, e.g. [227, 139, 79, 255]"),
      },
      ...mapUi,
    },
    async ({ layerId, color }) => {
      try {
        requireToken(token);
        const [r, g, b, a] = color;
        const updated = saveMapSession(
          token,
          styleOperationalLayer(
            requireSession(token),
            layerId,
            simpleRenderer([r, g, b, a]),
          ),
        );
        return await mapToolResult(token, portalUrl, updated);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  registerAppTool(
    server,
    "save_web_map",
    {
      title: "Save Web Map",
      description:
        "Save the current custom map as a Web Map item in the signed-in user's ArcGIS content. Returns the portal item id and Map Viewer URL. The map UI stays open.",
      inputSchema: {
        title: z.string().optional().describe("Override the map title when saving"),
      },
      ...mapUi,
    },
    async ({ title }) => {
      try {
        const client = createPortalClient({
          portalUrl,
          token: requireToken(token),
        });
        const session = requireSession(token);
        const { username } = await client.getSelf();
        const nextTitle = title ?? session.title;
        const itemId = session.itemId
          ? await client.updateWebMapItem({
              username,
              itemId: session.itemId,
              title: nextTitle,
              webmap: session.webmap,
            })
          : await client.addWebMapItem({
              username,
              title: nextTitle,
              webmap: session.webmap,
              snippet: "Created with the ArcGIS MCP App",
            });
        const updated = saveMapSession(token, {
          ...session,
          itemId,
          title: nextTitle,
          viewerUrl: mapViewerUrl(portalUrl, itemId),
        });
        return await mapToolResult(token, portalUrl, updated);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

app.listen(PORT, () => {
  console.log(`ArcGIS MCP Server running on port ${PORT}`);
  console.log(`MCP endpoint: /mcp`);
  console.log(`Health check: /health`);
});
