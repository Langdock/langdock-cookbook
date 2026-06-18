import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { randomUUID } from "node:crypto";
import { getInstanceUrl } from "../utils/getInstanceUrl.js";
import { getBaseUrl } from "../utils/getBaseUrl.js";

// ---------------------------------------------------------------------------
// In-Memory Storage
// Note: Use Redis/PostgreSQL in production for persistence across restarts
// ---------------------------------------------------------------------------

const registeredClients = new Map<string, OAuthClientInformationFull>();
const authorizationSessions = new Map<
  string,
  {
    clientId: string;
    codeChallenge: string;
    redirectUri: string;
    state?: string;
  }
>();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getServiceNowConfig() {
  const clientId = process.env.SERVICENOW_CLIENT_ID;
  const clientSecret = process.env.SERVICENOW_CLIENT_SECRET;
  if (!clientId) {
    throw new Error("SERVICENOW_CLIENT_ID environment variable is required");
  }
  return { clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// Client Store (Dynamic Client Registration)
// ---------------------------------------------------------------------------

class ServiceNowClientsStore implements OAuthRegisteredClientsStore {
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    let client = registeredClients.get(clientId);

    // Auto-accept MCP clients after server restart (in-memory storage is lost)
    // The /token endpoint needs to find the client to exchange the code
    if (!client && clientId.startsWith("mcp_")) {
      client = {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: [],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
      registeredClients.set(clientId, client);
    }

    return client;
  }

  registerClient(
    client: Omit<
      OAuthClientInformationFull,
      "client_id" | "client_id_issued_at"
    >,
  ): OAuthClientInformationFull {
    const fullClient: OAuthClientInformationFull = {
      ...client,
      client_id: `mcp_${randomUUID()}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    registeredClients.set(fullClient.client_id, fullClient);
    return fullClient;
  }
}

// ---------------------------------------------------------------------------
// OAuth Provider
// ---------------------------------------------------------------------------

export class ServiceNowOAuthProvider implements OAuthServerProvider {
  private _clientsStore = new ServiceNowClientsStore();

  // ServiceNow handles PKCE validation
  skipLocalPkceValidation = true;

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  /**
   * Not used - we handle /authorize directly in index.ts to avoid
   * the SDK's redirect_uri validation which requires persistent storage.
   */
  async authorize(
    _client: OAuthClientInformationFull,
    _params: AuthorizationParams,
    _res: Response,
  ): Promise<void> {
    throw new Error("Authorization handled directly by Express route");
  }

  async challengeForAuthorizationCode(): Promise<string> {
    // Not called when skipLocalPkceValidation is true
    return "";
  }

  /**
   * Exchange authorization code for tokens with ServiceNow.
   */
  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
  ): Promise<OAuthTokens> {
    const { clientId, clientSecret } = getServiceNowConfig();
    const instanceUrl = getInstanceUrl();
    const baseUrl = getBaseUrl();

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: `${baseUrl}/oauth/callback`,
      client_id: clientId,
    });

    if (clientSecret) {
      params.set("client_secret", clientSecret);
    }
    if (codeVerifier) {
      params.set("code_verifier", codeVerifier);
    }

    const response = await fetch(`${instanceUrl}/oauth_token.do`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Token exchange failed: ${response.status} - ${errorText}`,
      );
    }

    const tokens = await response.json();
    return {
      access_token: tokens.access_token,
      token_type: tokens.token_type || "Bearer",
      expires_in: tokens.expires_in,
      refresh_token: tokens.refresh_token,
      scope: tokens.scope,
    };
  }

  /**
   * Refresh an access token with ServiceNow.
   */
  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const { clientId, clientSecret } = getServiceNowConfig();
    const instanceUrl = getInstanceUrl();

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });

    if (clientSecret) {
      params.set("client_secret", clientSecret);
    }
    if (scopes?.length) {
      params.set("scope", scopes.join(" "));
    }

    const response = await fetch(`${instanceUrl}/oauth_token.do`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Token refresh failed: ${response.status} - ${errorText}`,
      );
    }

    const tokens = await response.json();
    return {
      access_token: tokens.access_token,
      token_type: tokens.token_type || "Bearer",
      expires_in: tokens.expires_in,
      refresh_token: tokens.refresh_token,
      scope: tokens.scope,
    };
  }

  /**
   * Verify access token validity.
   * In production, consider introspecting with ServiceNow.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return {
      token,
      clientId: "servicenow",
      scopes: ["useraccount"],
    };
  }

  async revokeToken(): Promise<void> {
    // ServiceNow doesn't have a standard revocation endpoint
  }
}

// ---------------------------------------------------------------------------
// Session Helpers (used by /authorize and /oauth/callback in index.ts)
// ---------------------------------------------------------------------------

export function storeAuthorizationSession(
  sessionId: string,
  session: {
    clientId: string;
    codeChallenge: string;
    redirectUri: string;
    state?: string;
  },
): void {
  authorizationSessions.set(sessionId, session);
}

export function getAuthorizationSession(sessionId: string) {
  return authorizationSessions.get(sessionId);
}

export function deleteAuthorizationSession(sessionId: string): void {
  authorizationSessions.delete(sessionId);
}
