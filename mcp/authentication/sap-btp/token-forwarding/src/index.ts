import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import express, { Request, Response, NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
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

function loadXsuaaConfig(): XsuaaConfig {
  if (process.env.VCAP_SERVICES) {
    try {
      const vcap = JSON.parse(process.env.VCAP_SERVICES);
      const xsuaaBinding = vcap.xsuaa?.[0]?.credentials;
      if (xsuaaBinding?.url && xsuaaBinding?.clientid && xsuaaBinding?.clientsecret) {
        return {
          url: xsuaaBinding.url.replace(/\/$/, ""),
          clientId: xsuaaBinding.clientid,
          clientSecret: xsuaaBinding.clientsecret,
        };
      }
    } catch (err) {
      console.warn("Failed to parse VCAP_SERVICES:", err);
    }
  }

  return {
    url: (process.env.XSUAA_URL || "").replace(/\/$/, ""),
    clientId: process.env.XSUAA_CLIENT_ID || "",
    clientSecret: process.env.XSUAA_CLIENT_SECRET || "",
  };
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

const xsuaa = loadXsuaaConfig();
const SERVER_URL = resolveServerUrl();
const PORT = parseInt(process.env.PORT || "3333", 10);
const ALLOWED_REDIRECT_URI_ORIGINS = new Set(
  (
    process.env.ALLOWED_REDIRECT_URI_ORIGINS ||
    "https://app.langdock.com,http://localhost:3000,http://localhost:3333,http://127.0.0.1:3000,http://127.0.0.1:3333"
  )
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean)
);

function isAllowedRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return ALLOWED_REDIRECT_URI_ORIGINS.has(parsed.origin);
  } catch {
    return false;
  }
}

const XSUAA_AUTHORIZE_URL = `${xsuaa.url}/oauth/authorize`;
const XSUAA_TOKEN_URL = `${xsuaa.url}/oauth/token`;
const XSUAA_USERINFO_URL = `${xsuaa.url}/userinfo`;
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

interface StoredRefreshToken {
  clientId: string;
  xsuaaRefreshToken: string;
  scopes: string[];
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
    if (
      !client.redirect_uris?.length ||
      !client.redirect_uris.every((u) => isAllowedRedirectUri(String(u)))
    ) {
      throw new Error(
        "Unallowed redirect_uri origin. Add the client origin to ALLOWED_REDIRECT_URI_ORIGINS."
      );
    }
    this.clients.set(client.client_id, client);
    return client;
  }
}

const pendingAuths = new Map<string, PendingAuth>();
const authCodes = new Map<string, StoredCode>();
const activeTokens = new Map<string, AuthInfo & { xsuaaAccessToken: string }>();
const refreshTokens = new Map<string, StoredRefreshToken>();

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

    let opaqueRefreshToken: string | undefined;
    if (stored.xsuaaRefreshToken) {
      opaqueRefreshToken = randomUUID();
      refreshTokens.set(opaqueRefreshToken, {
        clientId: client.client_id,
        xsuaaRefreshToken: stored.xsuaaRefreshToken,
        scopes: stored.scopes,
      });
    }

    console.log(`Issued access token for client ${client.client_id}`);

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      scope: stored.scopes.join(" "),
      ...(opaqueRefreshToken && {
        refresh_token: opaqueRefreshToken,
      }),
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string
  ): Promise<OAuthTokens> {
    const storedRefresh = refreshTokens.get(refreshToken);
    if (!storedRefresh || storedRefresh.clientId !== client.client_id) {
      throw new InvalidTokenError("Invalid or unknown refresh token");
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: storedRefresh.xsuaaRefreshToken,
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

    refreshTokens.delete(refreshToken);
    let nextOpaqueRefreshToken: string | undefined;
    const nextUpstreamRefresh = tokens.refresh_token || storedRefresh.xsuaaRefreshToken;
    if (nextUpstreamRefresh) {
      nextOpaqueRefreshToken = randomUUID();
      refreshTokens.set(nextOpaqueRefreshToken, {
        clientId: client.client_id,
        xsuaaRefreshToken: nextUpstreamRefresh,
        scopes: storedRefresh.scopes,
      });
    }

    activeTokens.set(accessToken, {
      token: accessToken,
      clientId: client.client_id,
      scopes: storedRefresh.scopes,
      expiresAt: Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600),
      xsuaaAccessToken: tokens.access_token,
    });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: tokens.expires_in,
      scope: storedRefresh.scopes.join(" "),
      ...(nextOpaqueRefreshToken && { refresh_token: nextOpaqueRefreshToken }),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = activeTokens.get(token);
    if (!stored) {
      throw new InvalidTokenError("Invalid or unknown token");
    }
    if (stored.expiresAt && stored.expiresAt < Math.floor(Date.now() / 1000)) {
      activeTokens.delete(token);
      throw new InvalidTokenError("Token has expired");
    }
    return {
      token: stored.token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: stored.expiresAt,
    };
  }
}

// --- SAP BTP XSUAA Userinfo & JWT Claims helper ---

async function getXsuaaUserInfo(xsuaaToken: string): Promise<any> {
  const response = await fetch(XSUAA_USERINFO_URL, {
    headers: { Authorization: `Bearer ${xsuaaToken}` },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `XSUAA userinfo error (${response.status}): ${errorBody}`
    );
  }

  return response.json();
}

function decodeJwtPayload(jwt: string): Record<string, any> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

// --- MCP Server ---

function createMcpServer(): Server {
  const mcpServer = new Server(
    { name: "sample-mcp-sap-btp-token-forwarding", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  mcpServer.setRequestHandler(
    ListToolsRequestSchema,
    async () => ({
      tools: [
        {
          name: "get-current-user",
          description:
            "Get information about the currently authenticated SAP BTP user by forwarding their XSUAA bearer token",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    })
  );

  mcpServer.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) => {
      if (request.params.name === "get-current-user") {
        try {
          const authInfo = extra.authInfo;
          if (!authInfo) {
            throw new Error("Not authenticated");
          }
          const stored = activeTokens.get(authInfo.token);
          if (!stored) {
            throw new Error("No SAP XSUAA token found for this session");
          }

          const profile = await getXsuaaUserInfo(stored.xsuaaAccessToken);
          const claims = decodeJwtPayload(stored.xsuaaAccessToken);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    user: {
                      user_id: profile.user_id || claims.user_id,
                      user_name: profile.user_name || claims.user_name,
                      email: profile.email || claims.email,
                      given_name: profile.given_name || claims.given_name,
                      family_name: profile.family_name || claims.family_name,
                      origin: claims.origin,
                      subaccount_id: claims.ext_attr?.subaccountid,
                      scopes: claims.scope,
                    },
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
  if (!xsuaa.url || !xsuaa.clientId || !xsuaa.clientSecret) {
    console.error(
      "Missing XSUAA configuration. Bind an xsuaa service instance on SAP BTP (VCAP_SERVICES) or set XSUAA_URL, XSUAA_CLIENT_ID, and XSUAA_CLIENT_SECRET."
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
    console.log(`${req.method} ${req.path}`);
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
    if (clientId && redirectUri && isAllowedRedirectUri(redirectUri)) {
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
    console.log(`MCP server with SAP BTP XSUAA auth running on ${SERVER_URL} (port ${PORT})`);
    console.log(
      `OAuth metadata: ${SERVER_URL}/.well-known/oauth-authorization-server`
    );
    console.log(`MCP endpoint: ${SERVER_URL}/mcp`);
  });
}

main().catch(console.error);
