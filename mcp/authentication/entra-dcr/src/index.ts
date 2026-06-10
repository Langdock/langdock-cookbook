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

const ENTRA_TENANT_ID = process.env.ENTRA_TENANT_ID!;
const ENTRA_CLIENT_ID = process.env.ENTRA_CLIENT_ID!;
const ENTRA_CLIENT_SECRET = process.env.ENTRA_CLIENT_SECRET!;
const RAW_SERVER_URL = process.env.SERVER_URL || "http://localhost:3333";
const SERVER_URL = RAW_SERVER_URL.startsWith("http") ? RAW_SERVER_URL : `https://${RAW_SERVER_URL}`;
const PORT = parseInt(process.env.PORT || "3333", 10);

const ENTRA_AUTHORITY = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0`;
const ENTRA_AUTHORIZE_URL = `${ENTRA_AUTHORITY}/authorize`;
const ENTRA_TOKEN_URL = `${ENTRA_AUTHORITY}/token`;
const ENTRA_SCOPES = "User.Read";
const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

// --- In-memory stores ---

interface PendingAuth {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
}

interface StoredCode {
  clientId: string;
  entraAccessToken: string;
  entraRefreshToken?: string;
  entraExpiresIn?: number;
  codeChallenge: string;
  scopes: string[];
  redirectUri: string;
}

// In-memory client store for DCR
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

// Pending authorization requests (keyed by state sent to Entra)
const pendingAuths = new Map<string, PendingAuth>();

// Authorization codes issued by our server (keyed by code)
const authCodes = new Map<string, StoredCode>();

// Active access tokens (keyed by token → AuthInfo)
const activeTokens = new Map<string, AuthInfo & { entraAccessToken: string }>();

// --- Entra ID OAuth Provider ---

class EntraOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new InMemoryClientsStore();

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    // Generate a unique state to track this auth request
    const entraState = randomUUID();

    // Store the pending auth so we can complete it when Entra calls back
    pendingAuths.set(entraState, { client, params });

    // Redirect the user to Entra ID's authorize endpoint
    const entraAuthUrl = new URL(ENTRA_AUTHORIZE_URL);
    entraAuthUrl.searchParams.set("client_id", ENTRA_CLIENT_ID);
    entraAuthUrl.searchParams.set("response_type", "code");
    entraAuthUrl.searchParams.set(
      "redirect_uri",
      `${SERVER_URL}/entra/callback`
    );
    entraAuthUrl.searchParams.set("scope", ENTRA_SCOPES);
    entraAuthUrl.searchParams.set("state", entraState);
    entraAuthUrl.searchParams.set("response_mode", "query");

    console.log(`Redirecting user to Entra ID for authentication`);
    res.redirect(entraAuthUrl.toString());
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

    // Remove the used code
    authCodes.delete(authorizationCode);

    // Generate our own access token that maps to the Entra token
    const accessToken = randomUUID();
    const expiresIn = stored.entraExpiresIn || 3600;

    activeTokens.set(accessToken, {
      token: accessToken,
      clientId: client.client_id,
      scopes: stored.scopes,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      entraAccessToken: stored.entraAccessToken,
    });

    console.log(`Issued access token for client ${client.client_id}`);

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      scope: stored.scopes.join(" "),
      ...(stored.entraRefreshToken && {
        refresh_token: stored.entraRefreshToken,
      }),
    };
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string
  ): Promise<OAuthTokens> {
    // Exchange refresh token at Entra's token endpoint
    const body = new URLSearchParams({
      client_id: ENTRA_CLIENT_ID,
      client_secret: ENTRA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: ENTRA_SCOPES,
    });

    const response = await fetch(ENTRA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Entra token refresh failed: ${errorText}`);
    }

    const tokens = (await response.json()) as Record<string, any>;
    const accessToken = randomUUID();

    activeTokens.set(accessToken, {
      token: accessToken,
      clientId: _client.client_id,
      scopes: tokens.scope ? tokens.scope.split(" ") : [],
      expiresAt: Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600),
      entraAccessToken: tokens.access_token,
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

// --- Microsoft Graph helper ---

async function callGraphApi(entraToken: string, endpoint: string): Promise<any> {
  const response = await fetch(`${GRAPH_BASE_URL}${endpoint}`, {
    headers: { Authorization: `Bearer ${entraToken}` },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Graph API error (${response.status}): ${errorBody}`);
  }

  return response.json();
}

// --- MCP Server ---

const mcpServer = new Server(
  { name: "sample-mcp-entra-auth", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(
  ListToolsRequestSchema,
  async () => ({
    tools: [
      {
        name: "get-current-user",
        description:
          "Get information about the currently authenticated Microsoft Entra ID user",
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
        // Get the Entra token from the authenticated request
        const authInfo = extra.authInfo;
        if (!authInfo) {
          throw new Error("Not authenticated");
        }
        const stored = activeTokens.get(authInfo.token);
        if (!stored) {
          throw new Error("No Entra token found for this session");
        }

        const profile = await callGraphApi(stored.entraAccessToken, "/me");

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  user: {
                    id: profile.id,
                    displayName: profile.displayName,
                    mail: profile.mail,
                    userPrincipalName: profile.userPrincipalName,
                    jobTitle: profile.jobTitle,
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
  if (!ENTRA_TENANT_ID || !ENTRA_CLIENT_ID || !ENTRA_CLIENT_SECRET) {
    console.error(
      "Missing required environment variables: ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET"
    );
    process.exit(1);
  }

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

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

  // OAuth provider
  const provider = new EntraOAuthProvider();

  // Mount OAuth routes (handles /authorize, /token, /register, /.well-known/*)
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(SERVER_URL),
      scopesSupported: [ENTRA_SCOPES],
    })
  );

  // Entra ID callback - handles the redirect from Entra after user authenticates
  app.get("/entra/callback", async (req: Request, res: Response) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
      console.error(`Entra auth error: ${error} - ${error_description}`);
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
      // Exchange Entra's auth code for tokens
      const tokenBody = new URLSearchParams({
        client_id: ENTRA_CLIENT_ID,
        client_secret: ENTRA_CLIENT_SECRET,
        code: code as string,
        redirect_uri: `${SERVER_URL}/entra/callback`,
        grant_type: "authorization_code",
        scope: ENTRA_SCOPES,
      });

      const tokenResponse = await fetch(ENTRA_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenBody.toString(),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        throw new Error(`Entra token exchange failed: ${errorText}`);
      }

      const entraTokens = (await tokenResponse.json()) as Record<string, any>;

      // Generate our own authorization code for the MCP client
      const ourCode = randomUUID();
      authCodes.set(ourCode, {
        clientId: pending.client.client_id,
        entraAccessToken: entraTokens.access_token,
        entraRefreshToken: entraTokens.refresh_token,
        entraExpiresIn: entraTokens.expires_in,
        codeChallenge: pending.params.codeChallenge,
        scopes: pending.params.scopes || [],
        redirectUri: pending.params.redirectUri,
      });

      // Redirect back to the MCP client's redirect_uri with our code
      const redirectUrl = new URL(pending.params.redirectUri);
      redirectUrl.searchParams.set("code", ourCode);
      if (pending.params.state) {
        redirectUrl.searchParams.set("state", pending.params.state);
      }

      console.log(
        `Entra auth successful, redirecting to client with auth code`
      );
      res.redirect(redirectUrl.toString());
    } catch (err) {
      console.error("Error in Entra callback:", err);
      res.status(500).json({
        error: "token_exchange_failed",
        error_description:
          err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Bearer auth middleware for MCP endpoints
  const authMiddleware = requireBearerAuth({ verifier: provider });

  // MCP transport store
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // MCP endpoint - protected by bearer auth
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
    console.log(`MCP server with Entra ID auth running on ${SERVER_URL}`);
    console.log(`OAuth metadata: ${SERVER_URL}/.well-known/oauth-authorization-server`);
    console.log(`MCP endpoint: ${SERVER_URL}/mcp`);
  });
}

main().catch(console.error);
