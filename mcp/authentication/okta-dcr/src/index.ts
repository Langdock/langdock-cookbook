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

// --- Configuration ---

const OKTA_DOMAIN = process.env.OKTA_DOMAIN!;
const OKTA_CLIENT_ID = process.env.OKTA_CLIENT_ID!;
const OKTA_CLIENT_SECRET = process.env.OKTA_CLIENT_SECRET!;
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3333";
const PORT = parseInt(process.env.PORT || "3333", 10);

const OKTA_BASE_URL = `https://${OKTA_DOMAIN}`;
const OKTA_AUTHORIZE_URL = `${OKTA_BASE_URL}/authorize`;
const OKTA_TOKEN_URL = `${OKTA_BASE_URL}/oauth/token`;
const OKTA_USERINFO_URL = `${OKTA_BASE_URL}/userinfo`;
const OKTA_SCOPES = "openid profile email";
const OKTA_BASIC_AUTH = Buffer.from(`${OKTA_CLIENT_ID}:${OKTA_CLIENT_SECRET}`).toString("base64");

// --- In-memory stores ---

interface PendingAuth {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
}

interface StoredCode {
  clientId: string;
  oktaAccessToken: string;
  oktaRefreshToken?: string;
  oktaExpiresIn?: number;
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
const activeTokens = new Map<string, AuthInfo & { oktaAccessToken: string }>();

// --- Okta OAuth Provider ---

class OktaOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new InMemoryClientsStore();

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const oktaState = randomUUID();
    pendingAuths.set(oktaState, { client, params });

    const oktaAuthUrl = new URL(OKTA_AUTHORIZE_URL);
    oktaAuthUrl.searchParams.set("client_id", OKTA_CLIENT_ID);
    oktaAuthUrl.searchParams.set("response_type", "code");
    oktaAuthUrl.searchParams.set(
      "redirect_uri",
      `${SERVER_URL}/okta/callback`
    );
    oktaAuthUrl.searchParams.set("scope", OKTA_SCOPES);
    oktaAuthUrl.searchParams.set("state", oktaState);
    oktaAuthUrl.searchParams.set("response_mode", "query");

    console.log(`Redirecting user to Okta for authentication`);
    res.redirect(oktaAuthUrl.toString());
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
    const expiresIn = stored.oktaExpiresIn || 3600;

    activeTokens.set(accessToken, {
      token: accessToken,
      clientId: client.client_id,
      scopes: stored.scopes,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      oktaAccessToken: stored.oktaAccessToken,
    });

    console.log(`Issued access token for client ${client.client_id}`);

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      scope: stored.scopes.join(" "),
      ...(stored.oktaRefreshToken && {
        refresh_token: stored.oktaRefreshToken,
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
      scope: OKTA_SCOPES,
    });

    const response = await fetch(OKTA_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${OKTA_BASIC_AUTH}`,
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Okta token refresh failed: ${errorText}`);
    }

    const tokens = (await response.json()) as Record<string, any>;
    const accessToken = randomUUID();

    activeTokens.set(accessToken, {
      token: accessToken,
      clientId: _client.client_id,
      scopes: tokens.scope ? tokens.scope.split(" ") : [],
      expiresAt: Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600),
      oktaAccessToken: tokens.access_token,
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

// --- Okta Userinfo helper ---

async function getOktaUserInfo(oktaToken: string): Promise<any> {
  const response = await fetch(OKTA_USERINFO_URL, {
    headers: { Authorization: `Bearer ${oktaToken}` },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Okta userinfo error (${response.status}): ${errorBody}`);
  }

  return response.json();
}

// --- MCP Server ---

const mcpServer = new Server(
  { name: "sample-mcp-okta-auth", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(
  ListToolsRequestSchema,
  async () => ({
    tools: [
      {
        name: "get-current-user",
        description:
          "Get information about the currently authenticated Okta user",
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
          throw new Error("No Okta token found for this session");
        }

        const profile = await getOktaUserInfo(stored.oktaAccessToken);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  user: {
                    sub: profile.sub,
                    name: profile.name,
                    email: profile.email,
                    email_verified: profile.email_verified,
                    preferred_username: profile.preferred_username,
                    locale: profile.locale,
                    zoneinfo: profile.zoneinfo,
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

// --- HTTP Server ---

async function main() {
  if (!OKTA_DOMAIN || !OKTA_CLIENT_ID || !OKTA_CLIENT_SECRET) {
    console.error(
      "Missing required environment variables: OKTA_DOMAIN, OKTA_CLIENT_ID, OKTA_CLIENT_SECRET"
    );
    process.exit(1);
  }

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Request logging
  app.use((req: Request, _res: Response, next: NextFunction) => {
    console.log(`${req.method} ${req.path}`, req.method === "GET" ? req.query : "");
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

  const provider = new OktaOAuthProvider();

  // Auto-register unknown clients on /authorize to survive redeploys
  // (in-memory store is wiped on each deploy, but clients cache their client_id)
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
      scopesSupported: OKTA_SCOPES.split(" "),
    })
  );

  // Okta callback
  app.get("/okta/callback", async (req: Request, res: Response) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
      console.error(`Okta auth error: ${error} - ${error_description}`);
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
        redirect_uri: `${SERVER_URL}/okta/callback`,
        grant_type: "authorization_code",
        scope: OKTA_SCOPES,
      });

      const tokenResponse = await fetch(OKTA_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${OKTA_BASIC_AUTH}`,
        },
        body: tokenBody.toString(),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        throw new Error(`Okta token exchange failed: ${errorText}`);
      }

      const oktaTokens = (await tokenResponse.json()) as Record<string, any>;

      const ourCode = randomUUID();
      authCodes.set(ourCode, {
        clientId: pending.client.client_id,
        oktaAccessToken: oktaTokens.access_token,
        oktaRefreshToken: oktaTokens.refresh_token,
        oktaExpiresIn: oktaTokens.expires_in,
        codeChallenge: pending.params.codeChallenge,
        scopes: pending.params.scopes || [],
        redirectUri: pending.params.redirectUri,
      });

      const redirectUrl = new URL(pending.params.redirectUri);
      redirectUrl.searchParams.set("code", ourCode);
      if (pending.params.state) {
        redirectUrl.searchParams.set("state", pending.params.state);
      }

      console.log(
        `Okta auth successful, redirecting to client with auth code`
      );
      res.redirect(redirectUrl.toString());
    } catch (err) {
      console.error("Error in Okta callback:", err);
      res.status(500).json({
        error: "token_exchange_failed",
        error_description:
          err instanceof Error ? err.message : String(err),
      });
    }
  });

  const authMiddleware = requireBearerAuth({ verifier: provider });

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // MCP endpoint - POST (messages)
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

        await mcpServer.connect(transport);
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

  // GET /mcp for SSE streams
  app.get("/mcp", authMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  // DELETE /mcp for session termination
  app.delete("/mcp", authMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.listen(PORT, () => {
    console.log(`MCP server with Okta auth running on ${SERVER_URL}`);
    console.log(
      `OAuth metadata: ${SERVER_URL}/.well-known/oauth-authorization-server`
    );
    console.log(`MCP endpoint: ${SERVER_URL}/mcp`);
  });
}

main().catch(console.error);
