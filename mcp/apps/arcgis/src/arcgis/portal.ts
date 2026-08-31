export function getPortalUrl(
  customHeaders: Record<string, string> = {},
): string {
  const fromHeader =
    customHeaders["x-arcgis-portal-url"] || customHeaders["x-portal-url"];
  const raw = fromHeader || process.env.ARCGIS_PORTAL_URL || "https://www.arcgis.com";
  return raw.replace(/\/$/, "");
}

export function mapViewerUrl(portalUrl: string, itemId: string): string {
  const origin = new URL(portalUrl).origin;
  return `${origin}/home/webmap/viewer.html?webmap=${encodeURIComponent(itemId)}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class ArcgisPortalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArcgisPortalError";
  }
}

export function createPortalClient({
  portalUrl,
  token,
  fetchImpl = fetch,
}: {
  portalUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}) {
  if (!token) {
    throw new ArcgisPortalError(
      "Sign in with ArcGIS OAuth to create and save custom web maps.",
    );
  }

  const getJson = async (path: string, params: Record<string, string> = {}) => {
    const search = new URLSearchParams({ ...params, f: "json", token });
    const response = await fetchImpl(`${portalUrl}${path}?${search.toString()}`, {
      method: "GET",
      signal: AbortSignal.timeout(20_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ArcgisPortalError(`ArcGIS request failed (${response.status})`);
    }
    if (isRecord(payload) && isRecord(payload.error)) {
      const message =
        typeof payload.error.message === "string"
          ? payload.error.message
          : "ArcGIS request failed";
      throw new ArcgisPortalError(message);
    }
    return payload;
  };

  const postForm = async (path: string, params: Record<string, string>) => {
    const body = new URLSearchParams({ ...params, f: "json", token });
    const response = await fetchImpl(`${portalUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ArcgisPortalError(`ArcGIS request failed (${response.status})`);
    }
    if (isRecord(payload) && isRecord(payload.error)) {
      const message =
        typeof payload.error.message === "string"
          ? payload.error.message
          : "ArcGIS request failed";
      throw new ArcgisPortalError(message);
    }
    return payload;
  };

  const getSelf = async () => {
    const payload = await getJson("/sharing/rest/community/self");
    if (!isRecord(payload) || typeof payload.username !== "string") {
      throw new ArcgisPortalError("Could not read the signed-in ArcGIS user");
    }
    return {
      username: payload.username,
      orgId: typeof payload.orgId === "string" ? payload.orgId : undefined,
    };
  };

  const searchContent = async ({
    query,
    num = 10,
  }: {
    query: string;
    num?: number;
  }) => {
    const payload = await getJson("/sharing/rest/search", {
      q: query,
      num: String(Math.min(25, Math.max(1, num))),
      sortField: "avgRating",
      sortOrder: "desc",
    });
    const results = isRecord(payload) && Array.isArray(payload.results)
      ? payload.results
      : [];
    return results.flatMap((item) => {
      if (!isRecord(item) || typeof item.id !== "string") return [];
      return [
        {
          id: item.id,
          title: typeof item.title === "string" ? item.title : item.id,
          type: typeof item.type === "string" ? item.type : "Unknown",
          owner: typeof item.owner === "string" ? item.owner : "",
          snippet: typeof item.snippet === "string" ? item.snippet : "",
          url: typeof item.url === "string" ? item.url : undefined,
          access: typeof item.access === "string" ? item.access : undefined,
        },
      ];
    });
  };

  const getItem = async (itemId: string) => {
    const payload = await getJson(`/sharing/rest/content/items/${itemId}`);
    if (!isRecord(payload) || typeof payload.id !== "string") {
      throw new ArcgisPortalError(`Item ${itemId} was not found`);
    }
    return {
      id: payload.id,
      title: typeof payload.title === "string" ? payload.title : payload.id,
      type: typeof payload.type === "string" ? payload.type : "Unknown",
      url: typeof payload.url === "string" ? payload.url : undefined,
      owner: typeof payload.owner === "string" ? payload.owner : "",
    };
  };

  const getItemData = async (itemId: string) => {
    return getJson(`/sharing/rest/content/items/${itemId}/data`);
  };

  const addWebMapItem = async ({
    username,
    title,
    webmap,
    snippet,
  }: {
    username: string;
    title: string;
    webmap: unknown;
    snippet?: string;
  }) => {
    const payload = await postForm(
      `/sharing/rest/content/users/${encodeURIComponent(username)}/addItem`,
      {
        type: "Web Map",
        title,
        ...(snippet ? { snippet } : {}),
        text: JSON.stringify(webmap),
        overwrite: "true",
      },
    );
    if (!isRecord(payload) || payload.success !== true || typeof payload.id !== "string") {
      throw new ArcgisPortalError("Failed to create the web map item");
    }
    return payload.id;
  };

  const updateWebMapItem = async ({
    username,
    itemId,
    title,
    webmap,
  }: {
    username: string;
    itemId: string;
    title?: string;
    webmap: unknown;
  }) => {
    const payload = await postForm(
      `/sharing/rest/content/users/${encodeURIComponent(username)}/items/${encodeURIComponent(itemId)}/update`,
      {
        ...(title ? { title } : {}),
        text: JSON.stringify(webmap),
      },
    );
    if (!isRecord(payload) || payload.success !== true) {
      throw new ArcgisPortalError("Failed to update the web map item");
    }
    return itemId;
  };

  return {
    getSelf,
    searchContent,
    getItem,
    getItemData,
    addWebMapItem,
    updateWebMapItem,
  };
}

export function isAllowedLayerUrl(url: string, portalUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  const portalHost = new URL(portalUrl).hostname.toLowerCase();
  return (
    host === portalHost ||
    host.endsWith(".arcgis.com") ||
    host.endsWith(".arcgisonline.com") ||
    host.endsWith(".esri.com") ||
    host === "arcgis.com" ||
    host === "arcgisonline.com" ||
    host === "esri.com"
  );
}
