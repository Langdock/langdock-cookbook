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
import { getBaseUrl } from "../utils/getBaseUrl.js";

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

export function getArcgisPortalUrl(): string {
  return (process.env.ARCGIS_PORTAL_URL || "https://www.arcgis.com").replace(
    /\/$/,
    "",
  );
}

function getArcgisOAuthConfig() {
  const clientId = process.env.ARCGIS_CLIENT_ID;
  const clientSecret = process.env.ARCGIS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "ARCGIS_CLIENT_ID and ARCGIS_CLIENT_SECRET environment variables are required",
    );
  }
  return { clientId, clientSecret, portalUrl: getArcgisPortalUrl() };
}

class ArcgisClientsStore implements OAuthRegisteredClientsStore {
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    let client = registeredClients.get(clientId);

    // In-memory DCR is lost on every Railway restart. Recreate the client so
    // Langdock's stored client_id still works on POST /token.
    if (!client && clientId) {
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

export class ArcgisOAuthProvider implements OAuthServerProvider {
  private _clientsStore = new ArcgisClientsStore();

  skipLocalPkceValidation = true;

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  async authorize(
    _client: OAuthClientInformationFull,
    _params: AuthorizationParams,
    _res: Response,
  ): Promise<void> {
    throw new Error("Authorization handled directly by Express route");
  }

  async challengeForAuthorizationCode(): Promise<string> {
    return "";
  }

  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
  ): Promise<OAuthTokens> {
    const { clientId, clientSecret, portalUrl } = getArcgisOAuthConfig();
    const baseUrl = getBaseUrl();

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: `${baseUrl}/oauth/callback`,
      client_id: clientId,
      client_secret: clientSecret,
      f: "json",
    });

    const response = await fetch(`${portalUrl}/sharing/rest/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });

    const rawBody = await response.text();
    if (!response.ok) {
      console.error("ArcGIS token exchange failed", { status: response.status });
      throw new Error(`Token exchange failed: ${response.status}`);
    }

    let tokens: {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      error?: { message?: string; code?: number } | string;
    };
    try {
      tokens = JSON.parse(rawBody) as typeof tokens;
    } catch {
      throw new Error("ArcGIS token response was not JSON");
    }
    if (!tokens.access_token) {
      const message =
        typeof tokens.error === "string"
          ? tokens.error
          : tokens.error?.message || "ArcGIS token response did not include access_token";
      console.error("ArcGIS token response missing access_token");
      throw new Error(message);
    }
    return {
      access_token: tokens.access_token,
      token_type: "Bearer",
      expires_in: tokens.expires_in,
      refresh_token: tokens.refresh_token,
    };
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const { clientId, clientSecret, portalUrl } = getArcgisOAuthConfig();

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      f: "json",
    });

    const response = await fetch(`${portalUrl}/sharing/rest/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    const tokens = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      error?: { message?: string } | string;
    };
    if (!tokens.access_token) {
      const message =
        typeof tokens.error === "string"
          ? tokens.error
          : tokens.error?.message || "ArcGIS refresh response did not include access_token";
      throw new Error(message);
    }
    return {
      access_token: tokens.access_token,
      token_type: "Bearer",
      expires_in: tokens.expires_in,
      refresh_token: tokens.refresh_token ?? refreshToken,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return {
      token,
      clientId: "arcgis",
      scopes: [],
    };
  }

  async revokeToken(): Promise<void> {}
}

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
