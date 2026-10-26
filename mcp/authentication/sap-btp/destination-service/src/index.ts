import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import express, { Request, Response, NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import dotenv from "dotenv";

dotenv.config();

// --- Configuration (VCAP_SERVICES on SAP BTP Cloud Foundry, with .env fallback) ---

interface XsuaaConfig {
  url: string;
  clientId: string;
  clientSecret: string;
}

interface DestinationServiceConfig {
  uri: string;
  authUrl: string;
  clientId: string;
  clientSecret: string;
}

function loadBtpConfigs(): {
  xsuaa: XsuaaConfig;
  destination: DestinationServiceConfig;
} {
  let xsuaa: XsuaaConfig = {
    url: (process.env.XSUAA_URL || "").replace(/\/$/, ""),
    clientId: process.env.XSUAA_CLIENT_ID || "",
    clientSecret: process.env.XSUAA_CLIENT_SECRET || "",
  };

  let destination: DestinationServiceConfig = {
    uri: (process.env.DESTINATION_URI || "").replace(/\/$/, ""),
    authUrl: (process.env.DESTINATION_AUTH_URL || process.env.XSUAA_URL || "").replace(/\/$/, ""),
    clientId: process.env.DESTINATION_CLIENT_ID || "",
    clientSecret: process.env.DESTINATION_CLIENT_SECRET || "",
  };

  if (process.env.VCAP_SERVICES) {
    try {
      const vcap = JSON.parse(process.env.VCAP_SERVICES);
      const xsuaaCreds = vcap.xsuaa?.[0]?.credentials;
      if (xsuaaCreds?.url && xsuaaCreds?.clientid && xsuaaCreds?.clientsecret) {
        xsuaa = {
          url: xsuaaCreds.url.replace(/\/$/, ""),
          clientId: xsuaaCreds.clientid,
          clientSecret: xsuaaCreds.clientsecret,
        };
      }

      const destCreds = vcap.destination?.[0]?.credentials;
      if (destCreds?.uri && destCreds?.url && destCreds?.clientid && destCreds?.clientsecret) {
        destination = {
          uri: destCreds.uri.replace(/\/$/, ""),
          authUrl: destCreds.url.replace(/\/$/, ""),
          clientId: destCreds.clientid,
          clientSecret: destCreds.clientsecret,
        };
      }
    } catch (err) {
      console.warn("Failed to parse VCAP_SERVICES:", err);
    }
  }

  return { xsuaa, destination };
}

function resolveServerUrl(): string {
  if (process.env.SERVER_URL) {
    return process.env.SERVER_URL.replace(/\/$/, "");
  }
  if (process.env.VCAP_APPLICATION) {
    try {
      const vcapApp = JSON.parse(process.env.VCAP_APPLICATION);
      const uri = vcapApp.application_uris?.[0];
      if (uri) {
        return `https://${uri}`;
      }
    } catch {
      // Ignore parse errors and fall back to localhost
    }
  }
  return "http://localhost:3333";
}

const { xsuaa, destination } = loadBtpConfigs();
const DEFAULT_DESTINATION_NAME = process.env.DEFAULT_DESTINATION_NAME || "ServiceNowPDI";
const SERVER_URL = resolveServerUrl();
const PORT = parseInt(process.env.PORT || "3333", 10);

const XSUAA_AUTHORIZE_URL = `${xsuaa.url}/oauth/authorize`;
const XSUAA_TOKEN_URL = `${xsuaa.url}/oauth/token`;
const XSUAA_SCOPES = "openid";
const XSUAA_BASIC_AUTH = Buffer.from(
  `${xsuaa.clientId}:${xsuaa.clientSecret}`
).toString("base64");

// --- In-memory stores ---

interface PendingAuth {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
}

interface StoredCode {
  clientId: string;
  xsuaaAccessToken: string;
  xsuaaRefreshToken?: string;
  xsuaaExpiresIn?: number;
  codeChallenge: string;
  scopes: string[];
  redirectUri: string;
}

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  async getClient(
    clientId: string
  ): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  async registerClient(
    client: OAuthClientInformationFull
  ): Promise<OAuthClientInformationFull> {
    this.clients.set(client.client_id, client);
    return client;
  }
}

const pendingAuths = new Map<string, PendingAuth>();
const authCodes = new Map<string, StoredCode>();
const activeTokens = new Map<string, AuthInfo & { xsuaaAccessToken: string }>();

// --- SAP BTP XSUAA OAuth Provider ---

class XsuaaOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new InMemoryClientsStore();

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const xsuaaState = randomUUID();
    pendingAuths.set(xsuaaState, { client, params });

    const authorizeUrl = new URL(XSUAA_AUTHORIZE_URL);
    authorizeUrl.searchParams.set("client_id", xsuaa.clientId);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", `${SERVER_URL}/xsuaa/callback`);
    authorizeUrl.searchParams.set("state", xsuaaState);

    console.log("Redirecting user to SAP BTP XSUAA for authentication");
    res.redirect(authorizeUrl.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const stored = authCodes.get(authorizationCode);
    if (!stored) {
      throw new Error("Invalid authorization code");
    }
    return stored.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
    const stored = authCodes.get(authorizationCode);
    if (!stored) {
      throw new Error("Invalid authorization code");
    }
    if (stored.clientId !== client.client_id) {
      throw new Error("Authorization code was not issued to this client");
    }

    authCodes.delete(authorizationCode);

    const accessToken = randomUUID();
    const expiresIn = stored.xsuaaExpiresIn || 3600;

    activeTokens.set(accessToken, {
      token: accessToken,
      clientId: client.client_id,
      scopes: stored.scopes,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      xsuaaAccessToken: stored.xsuaaAccessToken,
    });

    console.log(`Issued access token for client ${client.client_id}`);

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      scope: stored.scopes.join(" "),
      ...(stored.xsuaaRefreshToken && {
        refresh_token: stored.xsuaaRefreshToken,
      }),
    };
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string
  ): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    const response = await fetch(XSUAA_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${XSUAA_BASIC_AUTH}`,
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`XSUAA token refresh failed: ${errorText}`);
    }

    const tokens = (await response.json()) as Record<string, any>;
    const accessToken = randomUUID();

    activeTokens.set(accessToken, {
      token: accessToken,
      clientId: _client.client_id,
      scopes: tokens.scope ? tokens.scope.split(" ") : [],
      expiresAt: Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600),
      xsuaaAccessToken: tokens.access_token,
    });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: tokens.expires_in,
      scope: tokens.scope,
      ...(tokens.refresh_token && { refresh_token: tokens.refresh_token }),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = activeTokens.get(token);
    if (!stored) {
      throw new Error("Invalid or unknown token");
    }
    if (stored.expiresAt && stored.expiresAt < Math.floor(Date.now() / 1000)) {
      activeTokens.delete(token);
      throw new Error("Token has expired");
    }
    return {
      token: stored.token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: stored.expiresAt,
    };
  }
}

// --- SAP BTP Destination Service Client ---

interface ResolvedDestination {
  owner?: Record<string, any>;
  destinationConfiguration: {
    Name: string;
    Type: string;
    URL: string;
    Authentication: string;
    ProxyType?: string;
    Description?: string;
    [key: string]: any;
  };
  authTokens?: Array<{
    type: string;
    value: string;
    http_header: {
      key: string;
      value: string;
    };
    expires_in?: string;
    error?: string;
  }>;
}

async function getDestinationServiceToken(): Promise<string> {
  const basic = Buffer.from(
    `${destination.clientId}:${destination.clientSecret}`
  ).toString("base64");

  const response = await fetch(`${destination.authUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Destination service token request failed (${response.status}): ${text}`
    );
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

/**
 * Resolve a named destination from the SAP BTP Destination Service.
 *
 * When `forwardUserToken` is true (used for principal-propagation destinations such as
 * OAuth2JWTBearer, OAuth2SAMLBearerAssertion, or OAuth2UserTokenExchange), the user's
 * XSUAA JWT is passed in the `X-user-token` header so SAP BTP exchanges it for a
 * user-scoped target token automatically.
 */
async function resolveBtpDestination(
  destinationName: string,
  userXsuaaJwt?: string,
  forwardUserToken = false
): Promise<ResolvedDestination> {
  const serviceToken = await getDestinationServiceToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${serviceToken}`,
    Accept: "application/json",
  };

  if (forwardUserToken && userXsuaaJwt) {
    headers["X-user-token"] = userXsuaaJwt;
  }

  const url = `${destination.uri}/destination-configuration/v1/destinations/${encodeURIComponent(
    destinationName
  )}`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to resolve BTP destination "${destinationName}" (${response.status}): ${text}`
    );
  }

  return (await response.json()) as ResolvedDestination;
}

// --- MCP Server ---

function createMcpServer(): Server {
  const mcpServer = new Server(
    { name: "sample-mcp-sap-btp-destination", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  mcpServer.setRequestHandler(
    ListToolsRequestSchema,
    async () => ({
      tools: [
        {
          name: "resolve-btp-destination",
          description:
            "Resolve a named destination from the SAP BTP Destination Service and optionally execute a GET request against a relative path on that destination",
          inputSchema: {
            type: "object" as const,
            properties: {
              destinationName: {
                type: "string",
                description: `Name of the configured SAP BTP destination (defaults to "${DEFAULT_DESTINATION_NAME}")`,
              },
              path: {
                type: "string",
                description:
                  "Optional relative path to request on the resolved destination URL (e.g. \"/api/now/table/incident?sysparm_limit=1\" or \"/sap/opu/odata/...\")",
              },
              forwardUserToken: {
                type: "boolean",
                description:
                  "Pass the user's XSUAA JWT as X-user-token so SAP BTP performs principal propagation / user token exchange (for OAuth2JWTBearer / OAuth2SAMLBearerAssertion destinations)",
              },
            },
          },
        },
      ],
    })
  );

  mcpServer.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) => {
      if (request.params.name === "resolve-btp-destination") {
        try {
          const authInfo = extra.authInfo;
          if (!authInfo) {
            throw new Error("Not authenticated");
          }
          const stored = activeTokens.get(authInfo.token);
          if (!stored) {
            throw new Error("No SAP XSUAA token found for this session");
          }

          const args = (request.params.arguments || {}) as {
            destinationName?: string;
            path?: string;
            forwardUserToken?: boolean;
          };

          const destinationName = args.destinationName || DEFAULT_DESTINATION_NAME;
          const forwardUserToken = Boolean(args.forwardUserToken);

          const resolved = await resolveBtpDestination(
            destinationName,
            stored.xsuaaAccessToken,
            forwardUserToken
          );

          const config = resolved.destinationConfiguration;
          const authToken = resolved.authTokens?.[0];

          let targetResponse: Record<string, any> | undefined;
          if (args.path) {
            const targetUrl = new URL(
              args.path.replace(/^\//, ""),
              config.URL.endsWith("/") ? config.URL : `${config.URL}/`
            );

            const targetHeaders: Record<string, string> = {
              Accept: "application/json",
            };

            if (authToken?.http_header?.key && authToken?.http_header?.value) {
              targetHeaders[authToken.http_header.key] = authToken.http_header.value;
            }

            const resp = await fetch(targetUrl.toString(), {
              headers: targetHeaders,
            });
            const bodyText = await resp.text();
            let parsedBody: unknown = bodyText;
            try {
              parsedBody = JSON.parse(bodyText);
            } catch {
              // Keep raw text if not JSON
            }

            targetResponse = {
              url: targetUrl.toString(),
              status: resp.status,
              usedAuthHeader: authToken?.http_header?.key || "none",
              body: parsedBody,
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    destination: {
                      name: config.Name,
                      type: config.Type,
                      url: config.URL,
                      authentication: config.Authentication,
                      proxyType: config.ProxyType,
                      description: config.Description,
                      hasResolvedAuthToken: Boolean(authToken?.value),
                      authTokenType: authToken?.type || null,
                      authTokenError: authToken?.error || null,
                    },
                    ...(targetResponse && { targetResponse }),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    }
  );

  return mcpServer;
}

// --- HTTP Server ---

async function main() {
  if (
    !xsuaa.url ||
    !xsuaa.clientId ||
    !xsuaa.clientSecret ||
    !destination.uri ||
    !destination.clientId ||
    !destination.clientSecret
  ) {
    console.error(
      "Missing SAP BTP XSUAA or Destination Service configuration. Bind xsuaa and destination service instances on SAP BTP (VCAP_SERVICES) or set the environment variables in .env."
    );
    process.exit(1);
  }

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    console.log(`${req.method} ${req.path}`, req.method === "GET" ? req.query : "");
    res.on("finish", () => {
      if (res.statusCode >= 400) {
        console.log(`${req.method} ${req.path} -> ${res.statusCode}`);
      }
    });
    next();
  });

  // CORS
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, DELETE, OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, mcp-session-id"
    );
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }
    next();
  });

  const provider = new XsuaaOAuthProvider();

  // Auto-register unknown clients on /authorize to survive redeploys
  app.get("/authorize", async (req: Request, _res: Response, next: NextFunction) => {
    const clientId = req.query.client_id as string;
    const redirectUri = req.query.redirect_uri as string;
    if (clientId && redirectUri) {
      const existing = await provider.clientsStore.getClient(clientId);
      if (!existing) {
        console.log(`Auto-registering unknown client ${clientId}`);
        await provider.clientsStore.registerClient({
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        } as OAuthClientInformationFull);
      }
    }
    next();
  });

  // Mount OAuth routes (handles /authorize, /token, /register, /.well-known/*)
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(SERVER_URL),
      scopesSupported: XSUAA_SCOPES.split(" "),
    })
  );

  // SAP BTP XSUAA callback
  app.get("/xsuaa/callback", async (req: Request, res: Response) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
      console.error(`XSUAA auth error: ${error} - ${error_description}`);
      res.status(400).json({ error, error_description });
      return;
    }

    if (!state || !code) {
      res.status(400).json({ error: "Missing code or state" });
      return;
    }

    const pending = pendingAuths.get(state as string);
    if (!pending) {
      res.status(400).json({ error: "Unknown or expired state" });
      return;
    }
    pendingAuths.delete(state as string);

    try {
      const tokenBody = new URLSearchParams({
        code: code as string,
        redirect_uri: `${SERVER_URL}/xsuaa/callback`,
        grant_type: "authorization_code",
      });

      const tokenResponse = await fetch(XSUAA_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${XSUAA_BASIC_AUTH}`,
        },
        body: tokenBody.toString(),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        throw new Error(`XSUAA token exchange failed: ${errorText}`);
      }

      const xsuaaTokens = (await tokenResponse.json()) as Record<string, any>;

      const ourCode = randomUUID();
      authCodes.set(ourCode, {
        clientId: pending.client.client_id,
        xsuaaAccessToken: xsuaaTokens.access_token,
        xsuaaRefreshToken: xsuaaTokens.refresh_token,
        xsuaaExpiresIn: xsuaaTokens.expires_in,
        codeChallenge: pending.params.codeChallenge,
        scopes: pending.params.scopes || [],
        redirectUri: pending.params.redirectUri,
      });

      const redirectUrl = new URL(pending.params.redirectUri);
      redirectUrl.searchParams.set("code", ourCode);
      if (pending.params.state) {
        redirectUrl.searchParams.set("state", pending.params.state);
      }

      console.log("XSUAA auth successful, redirecting to client with auth code");
      res.redirect(redirectUrl.toString());
    } catch (err) {
      console.error("Error in XSUAA callback:", err);
      res.status(500).json({
        error: "token_exchange_failed",
        error_description:
          err instanceof Error ? err.message : String(err),
      });
    }
  });

  const authMiddleware = requireBearerAuth({ verifier: provider });

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", authMiddleware, async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            transports[newSessionId] = transport;
            console.log(`MCP session ${newSessionId} initialized`);
          },
          enableDnsRebindingProtection: true,
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
            console.log(`MCP session ${transport.sessionId} cleaned up`);
          }
        };

        await createMcpServer().connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          error: "Internal Server Error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  app.get("/mcp", authMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.delete("/mcp", authMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.listen(PORT, () => {
    console.log(
      `MCP server with SAP BTP Destination Service running on ${SERVER_URL} (port ${PORT})`
    );
    console.log(
      `OAuth metadata: ${SERVER_URL}/.well-known/oauth-authorization-server`
    );
    console.log(`MCP endpoint: ${SERVER_URL}/mcp`);
  });
}

main().catch(console.error);
