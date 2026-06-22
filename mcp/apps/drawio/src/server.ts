import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  buildDiagramXml,
  type DiagramNode,
  type DiagramEdge,
} from "./drawio/diagram.js";
import { encodeForDataAttr } from "./utils/encodeForDataAttr.js";
import { getEditorHtml } from "./utils/getEditorHtml.js";
import { safeJsonForHtml } from "./utils/safeJsonForHtml.js";

// ---------------------------------------------------------------------------
// Shared input schemas
// ---------------------------------------------------------------------------

const NODE_SHAPES = [
  "rectangle",
  "rounded",
  "ellipse",
  "diamond",
  "process",
  "terminator",
  "cylinder",
  "cloud",
  "hexagon",
  "parallelogram",
] as const;

const nodeSchema = z.object({
  id: z.string().describe("Unique id for this node, referenced by edges."),
  label: z.string().optional().describe("Text shown inside the shape."),
  shape: z
    .enum(NODE_SHAPES)
    .optional()
    .describe(
      "Visual shape (default: rectangle). Use 'diamond' for decisions, 'terminator' for start/end, 'cylinder' for data stores.",
    ),
  x: z.number().optional().describe("Absolute x position. Omit to auto-layout."),
  y: z.number().optional().describe("Absolute y position. Omit to auto-layout."),
  width: z.number().optional(),
  height: z.number().optional(),
  fillColor: z.string().optional().describe("Fill color hex, e.g. '#dae8fc'."),
  strokeColor: z.string().optional().describe("Border color hex, e.g. '#6c8ebf'."),
});

const edgeSchema = z.object({
  source: z.string().describe("id of the source node."),
  target: z.string().describe("id of the target node."),
  label: z.string().optional().describe("Optional label on the connector."),
  dashed: z.boolean().optional().describe("Render the connector dashed."),
});

const directionSchema = z
  .enum(["vertical", "horizontal"])
  .optional()
  .describe("Auto-layout flow direction (default: vertical).");

export const EDITOR_RESOURCE_URI = "ui://drawio/editor";

// The UI embeds the full draw.io EDITOR (embed.diagrams.net) in a nested
// iframe. Langdock's MCP-App sandbox applies no CSP today, so the iframe
// renders as-is — but hosts that honor resource-declared CSP map
// `frameDomains` to `frame-src` (default 'none'), so declare it on every
// path the host might read the resource from. `resourceDomains` covers the
// read-only viewer script used as fallback when the embed cannot load.
export const UI_RESOURCE_META = {
  ui: {
    csp: {
      frameDomains: ["https://embed.diagrams.net", "https://app.diagrams.net"],
      resourceDomains: ["https://viewer.diagrams.net"],
    },
    permissions: { clipboardWrite: {} },
  },
} as const;

// ---------------------------------------------------------------------------
// MCP Server Factory
// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "drawio-mcp-server",
    version: "1.0.0",
  });

  // Register the editor UI as an MCP App resource. The CSP meta is attached
  // both at the listing level and on the read content item (which takes
  // precedence in mcp-ui hosts).
  registerAppResource(
    server,
    EDITOR_RESOURCE_URI,
    EDITOR_RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE, _meta: UI_RESOURCE_META },
    async () => ({
      contents: [
        {
          uri: EDITOR_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await getEditorHtml(),
          _meta: UI_RESOURCE_META,
        },
      ],
    }),
  );

  // -------------------------------------------------------------------------
  // Tool: Create Diagram — build mxGraph XML from a structured description.
  // -------------------------------------------------------------------------
  server.registerTool(
    "create_diagram",
    {
      title: "Create Diagram",
      description:
        "Build a draw.io (diagrams.net) diagram from a structured description of nodes and edges. " +
        "Returns valid mxGraph XML that can be passed to render_diagram or opened in draw.io. " +
        "Positions are auto-laid-out when omitted — just describe what connects to what.",
      inputSchema: {
        nodes: z
          .array(nodeSchema)
          .describe("The shapes in the diagram, each with a unique id."),
        edges: z
          .array(edgeSchema)
          .optional()
          .describe("Connectors between nodes, referencing node ids."),
        direction: directionSchema,
      },
    },
    async ({ nodes, edges, direction }) => {
      try {
        const xml = buildDiagramXml(
          nodes as DiagramNode[],
          (edges ?? []) as DiagramEdge[],
          { direction },
        );
        return {
          content: [{ type: "text" as const, text: xml }],
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
  // Tool: Render Diagram (UI Tool) — interactive, editable draw.io canvas.
  // -------------------------------------------------------------------------
  registerAppTool(
    server,
    "render_diagram",
    {
      title: "Render Diagram",
      description:
        "Open an interactive, editable draw.io canvas in the client to display a diagram. " +
        "Pass ready-made mxGraph `xml` (typically the output of create_diagram) to render it, " +
        "or call with no `xml` to open a blank canvas for the user to draw from scratch. " +
        "The user can edit live and export to PNG, SVG, or XML. " +
        "Use create_diagram first to build the XML from a description, then pass it here. " +
        "This is the tool to use whenever the user wants to draw, render, visualize, or edit a diagram.",
      inputSchema: {
        xml: z
          .string()
          .optional()
          .describe(
            "The mxGraph XML to render, e.g. the output of create_diagram. Omit to open a blank canvas.",
          ),
        title: z
          .string()
          .optional()
          .describe("Title shown above the canvas (default: 'Diagram')."),
      },
      _meta: { ui: { resourceUri: EDITOR_RESOURCE_URI } },
    },
    async ({ xml, title }) => {
      try {
        // No xml => open a blank, editable canvas to start from scratch. The
        // editor UI defaults to an empty diagram when no xml is provided.
        const renderData: Record<string, unknown> = {
          title: title ?? "Diagram",
          editable: true,
        };
        if (xml) renderData.xml = xml;

        let html = await getEditorHtml();
        html = html.replace(
          '<div class="diagram-container">',
          `<div class="diagram-container" data-schema="${encodeForDataAttr(renderData)}">`,
        );
        html = html.replace(
          "</head>",
          `<script>window.DIAGRAM_DATA = ${safeJsonForHtml(renderData)};</script></head>`,
        );

        return {
          // First content item is the render data as JSON — matching the
          // google-maps app exactly, which is what the Langdock host renders
          // inline. (A plain-sentence text block here causes the host to treat
          // the resource as a file attachment instead.)
          content: [
            { type: "text", text: JSON.stringify(renderData) },
            {
              type: "resource",
              resource: {
                uri: EDITOR_RESOURCE_URI,
                mimeType: RESOURCE_MIME_TYPE,
                text: html,
                _meta: UI_RESOURCE_META,
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
