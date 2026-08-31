export const ARCGIS_MAP_UI_URI = "ui://arcgis/map";

export const ARCGIS_MAP_BASEMAPS = [
  "streets",
  "satellite",
  "topo",
  "dark",
  "oceans",
] as const;

export type ArcgisBasemapId = (typeof ARCGIS_MAP_BASEMAPS)[number];

export type ArcgisExtent = {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  spatialReference?: { wkid: number };
};

export type ArcgisOperationalLayer = {
  id: string;
  title: string;
  url: string;
  layerType: string;
  visibility: boolean;
  opacity: number;
  itemId?: string;
  layerDefinition?: Record<string, unknown>;
};

export type ArcgisWebMapDocument = {
  operationalLayers: ArcgisOperationalLayer[];
  baseMap: {
    title: string;
    baseMapLayers: Array<{
      id: string;
      url: string;
      layerType: string;
      opacity: number;
      visibility: boolean;
    }>;
  };
  spatialReference: { wkid: number };
  version: string;
  authoringApp: string;
  authoringAppVersion: string;
  initialState?: {
    viewpoint: {
      targetGeometry: ArcgisExtent;
    };
  };
};

export type ArcgisMapSession = {
  itemId?: string;
  title: string;
  webmap: ArcgisWebMapDocument;
  viewerUrl?: string;
};

const BASEMAP_LAYERS: Record<
  ArcgisBasemapId,
  { title: string; id: string; url: string }
> = {
  streets: {
    title: "Streets",
    id: "world-street-map",
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer",
  },
  satellite: {
    title: "Imagery",
    id: "world-imagery",
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer",
  },
  topo: {
    title: "Topographic",
    id: "world-topo-map",
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer",
  },
  dark: {
    title: "Dark Gray Canvas",
    id: "world-dark-gray",
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer",
  },
  oceans: {
    title: "Oceans",
    id: "world-ocean",
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer",
  },
};

const tiledBasemapLayer = (basemap: ArcgisBasemapId) => {
  const spec = BASEMAP_LAYERS[basemap];
  return {
    id: spec.id,
    url: spec.url,
    layerType: "ArcGISTiledMapServiceLayer",
    opacity: 1,
    visibility: true,
  };
};

export function createEmptyWebMap(
  title: string,
  basemap: ArcgisBasemapId = "streets",
  extent?: ArcgisExtent,
): ArcgisMapSession {
  const spec = BASEMAP_LAYERS[basemap];
  const webmap: ArcgisWebMapDocument = {
    operationalLayers: [],
    baseMap: {
      title: spec.title,
      baseMapLayers: [tiledBasemapLayer(basemap)],
    },
    spatialReference: { wkid: 102100 },
    version: "2.31",
    authoringApp: "ArcGIS MCP App",
    authoringAppVersion: "1.0.0",
    ...(extent
      ? {
          initialState: {
            viewpoint: {
              targetGeometry: {
                ...extent,
                spatialReference: extent.spatialReference ?? { wkid: 4326 },
              },
            },
          },
        }
      : {}),
  };
  return { title, webmap };
}

export function setBasemap(
  session: ArcgisMapSession,
  basemap: ArcgisBasemapId,
): ArcgisMapSession {
  const spec = BASEMAP_LAYERS[basemap];
  return {
    ...session,
    webmap: {
      ...session.webmap,
      baseMap: {
        title: spec.title,
        baseMapLayers: [tiledBasemapLayer(basemap)],
      },
    },
  };
}

export function setExtent(
  session: ArcgisMapSession,
  extent: ArcgisExtent,
): ArcgisMapSession {
  return {
    ...session,
    webmap: {
      ...session.webmap,
      initialState: {
        viewpoint: {
          targetGeometry: {
            ...extent,
            spatialReference: extent.spatialReference ?? { wkid: 4326 },
          },
        },
      },
    },
  };
}

export function addOperationalLayer(
  session: ArcgisMapSession,
  layer: Omit<ArcgisOperationalLayer, "visibility" | "opacity"> & {
    visibility?: boolean;
    opacity?: number;
  },
): ArcgisMapSession {
  const nextLayer: ArcgisOperationalLayer = {
    visibility: true,
    opacity: 1,
    ...layer,
  };
  const withoutDup = session.webmap.operationalLayers.filter(
    (existing) => existing.id !== nextLayer.id && existing.url !== nextLayer.url,
  );
  return {
    ...session,
    webmap: {
      ...session.webmap,
      operationalLayers: [...withoutDup, nextLayer],
    },
  };
}

export function removeOperationalLayer(
  session: ArcgisMapSession,
  layerId: string,
): ArcgisMapSession {
  return {
    ...session,
    webmap: {
      ...session.webmap,
      operationalLayers: session.webmap.operationalLayers.filter(
        (layer) => layer.id !== layerId && layer.title !== layerId,
      ),
    },
  };
}

export function styleOperationalLayer(
  session: ArcgisMapSession,
  layerId: string,
  renderer: Record<string, unknown>,
): ArcgisMapSession {
  return {
    ...session,
    webmap: {
      ...session.webmap,
      operationalLayers: session.webmap.operationalLayers.map((layer) =>
        layer.id === layerId || layer.title === layerId
          ? {
              ...layer,
              layerDefinition: {
                ...(layer.layerDefinition ?? {}),
                drawingInfo: { renderer },
              },
            }
          : layer,
      ),
    },
  };
}

export function summarizeSession(session: ArcgisMapSession): string {
  const layers =
    session.webmap.operationalLayers.length === 0
      ? "(no operational layers yet)"
      : session.webmap.operationalLayers
          .map((layer) => `- ${layer.title} [${layer.id}]`)
          .join("\n");
  const item = session.itemId ? `Portal item: ${session.itemId}` : "Not saved yet";
  const viewer = session.viewerUrl ? `\nMap Viewer: ${session.viewerUrl}` : "";
  return [
    `Map: ${session.title}`,
    item + viewer,
    `Basemap: ${session.webmap.baseMap.title}`,
    "Layers:",
    layers,
  ].join("\n");
}

export function simpleRenderer(color: [number, number, number, number?]): {
  type: string;
  symbol: Record<string, unknown>;
} {
  const [r, g, b, a = 255] = color;
  return {
    type: "simple",
    symbol: {
      type: "esriSMS",
      style: "esriSMSCircle",
      color: [r, g, b, a],
      size: 8,
      outline: { color: [255, 255, 255, 255], width: 1 },
    },
  };
}
