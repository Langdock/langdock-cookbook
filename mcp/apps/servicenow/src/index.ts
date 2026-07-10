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
  ServiceNowOAuthProvider,
  deleteAuthorizationSession,
  getAuthorizationSession,
  storeAuthorizationSession,
} from "./oauth/provider.js";
import {
  getActivity,
  getFormFields,
  getRecord,
  submitForm,
  updateRecord,
} from "./servicenow/client.js";
import { encodeForDataAttr } from "./utils/encodeForDataAttr.js";
import { extractCustomHeaders } from "./utils/extractCustomHeaders.js";
import { getBaseUrl } from "./utils/getBaseUrl.js";
import { getFormHtml } from "./utils/getFormHtml.js";
import { getTicketHtml } from "./utils/getTicketHtml.js";
import { getInstanceUrl } from "./utils/getInstanceUrl.js";
import { safeJsonForHtml } from "./utils/safeJsonForHtml.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// ---------------------------------------------------------------------------
// Express App Setup
// ---------------------------------------------------------------------------

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const baseUrl = getBaseUrl();
const oauthProvider = new ServiceNowOAuthProvider();

// ---------------------------------------------------------------------------
// OAuth Endpoints
// ---------------------------------------------------------------------------

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

  const snClientId = process.env.SERVICENOW_CLIENT_ID;
  const instanceUrl = getInstanceUrl();

  const authUrl = new URL(`${instanceUrl}/oauth_auth.do`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", snClientId!);
  authUrl.searchParams.set("redirect_uri", `${baseUrl}/oauth/callback`);
  authUrl.searchParams.set("state", sessionId);
  authUrl.searchParams.set("code_challenge", code_challenge as string);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("scope", "useraccount");

  res.redirect(authUrl.toString());
});

const authRouter = mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl: new URL(baseUrl),
  baseUrl: new URL(baseUrl),
  scopesSupported: ["useraccount"],
  resourceName: "ServiceNow MCP Server",
});
app.use("/", authRouter);

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

// ---------------------------------------------------------------------------
// MCP Endpoint
// ---------------------------------------------------------------------------

app.all("/mcp", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    // Return 401 to trigger OAuth flow in MCP clients
    if (!token) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Unauthorized - OAuth authentication required",
        },
        id: null,
      });
      return;
    }

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

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ---------------------------------------------------------------------------
// MCP Server Factory
// ---------------------------------------------------------------------------

function createMcpServer(
  token: string,
  customHeaders: Record<string, string> = {},
): McpServer {
  const server = new McpServer({
    name: "servicenow-mcp-server",
    version: "1.0.0",
  });

  const formResourceUri = "ui://servicenow/form";
  const ticketResourceUri = "ui://servicenow/ticket";

  // Register form UI resource
  registerAppResource(
    server,
    formResourceUri,
    formResourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: formResourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await getFormHtml(),
        },
      ],
    }),
  );

  // Register ticket UI resource (interactive view/edit panel)
  registerAppResource(
    server,
    ticketResourceUri,
    ticketResourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: ticketResourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await getTicketHtml(),
        },
      ],
    }),
  );

  // Tool: Submit a record to ServiceNow
  server.registerTool(
    "submit_form",
    {
      title: "Submit Form",
      description: "Submit a record to a ServiceNow table.",
      inputSchema: {
        table: z.string().describe("The ServiceNow table name"),
        data: z
          .record(z.string(), z.unknown())
          .describe("The form data to submit"),
      },
    },
    async ({ table, data }) => {
      try {
        const result = await submitForm(
          table,
          data as Record<string, unknown>,
          token,
          customHeaders,
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: String(error) }],
          isError: true,
        };
      }
    },
  );

  // Tool: Get form fields for a table
  server.registerTool(
    "get_form_fields",
    {
      title: "Get Form Fields",
      description: "Get the available fields for a ServiceNow table.",
      inputSchema: {
        table: z.string().describe("The ServiceNow table name"),
      },
    },
    async ({ table }) => {
      try {
        const schema = await getFormFields(table, token, customHeaders);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(schema, null, 2) },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: String(error) }],
          isError: true,
        };
      }
    },
  );

  // Tool: Render interactive form
  registerAppTool(
    server,
    "render_form",
    {
      title: "Render Form",
      description:
        "Display an interactive form to create a ServiceNow record. Optionally call get_form_fields first to see available fields.",
      inputSchema: {
        table: z.string().describe("The ServiceNow table name"),
        prefill: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Optional key-value pairs to pre-fill"),
      },
      _meta: { ui: { resourceUri: formResourceUri } },
    },
    async ({ table, prefill }) => {
      try {
        const schema = await getFormFields(table, token, customHeaders);
        const renderData = { ...schema, prefill: prefill || {} };
        let html = await getFormHtml();
        html = html.replace(
          '<div class="form-container">',
          `<div class="form-container" data-schema="${encodeForDataAttr(renderData)}">`,
        );
        html = html.replace(
          "</head>",
          `<script>window.FORM_SCHEMA = ${safeJsonForHtml(renderData)};</script></head>`,
        );
        return {
          content: [
            { type: "text", text: JSON.stringify(renderData) },
            {
              type: "resource",
              resource: {
                uri: formResourceUri,
                mimeType: RESOURCE_MIME_TYPE,
                text: html,
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

  // Tool: Get a single existing record
  server.registerTool(
    "get_record",
    {
      title: "Get Record",
      description:
        "Fetch a single existing ServiceNow record by sys_id or by its number (e.g. INC0010023).",
      inputSchema: {
        table: z.string().describe("The ServiceNow table name"),
        id: z
          .string()
          .describe("The record sys_id or human-readable number (e.g. INC0010023)"),
      },
    },
    async ({ table, id }) => {
      try {
        const record = await getRecord(table, id, token, customHeaders);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(record, null, 2) },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: String(error) }],
          isError: true,
        };
      }
    },
  );

  // Tool: Update fields on an existing record
  server.registerTool(
    "update_record",
    {
      title: "Update Record",
      description: "Update field values on an existing ServiceNow record.",
      inputSchema: {
        table: z.string().describe("The ServiceNow table name"),
        sys_id: z.string().describe("The sys_id of the record to update"),
        data: z
          .record(z.string(), z.unknown())
          .describe("The field values to update"),
      },
    },
    async ({ table, sys_id, data }) => {
      try {
        const record = await updateRecord(
          table,
          sys_id,
          data as Record<string, unknown>,
          token,
          customHeaders,
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(record, null, 2) },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: String(error) }],
          isError: true,
        };
      }
    },
  );

  // Tool: Append a comment or work note, and return the refreshed activity
  server.registerTool(
    "add_journal_entry",
    {
      title: "Add Journal Entry",
      description:
        "Append a comment (customer-visible) or work note (internal) to a record's activity stream.",
      inputSchema: {
        table: z.string().describe("The ServiceNow table name"),
        sys_id: z.string().describe("The sys_id of the record"),
        field: z
          .enum(["comments", "work_notes"])
          .describe("Which journal field to append to"),
        text: z.string().describe("The comment or work note text"),
      },
    },
    async ({ table, sys_id, field, text }) => {
      try {
        await updateRecord(
          table,
          sys_id,
          { [field]: text },
          token,
          customHeaders,
        );
        const activity = await getActivity(
          table,
          sys_id,
          token,
          customHeaders,
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ activity }, null, 2) },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: String(error) }],
          isError: true,
        };
      }
    },
  );

  // Tool: Render interactive ticket panel for an existing record
  registerAppTool(
    server,
    "render_ticket",
    {
      title: "Render Ticket",
      description:
        "Open an existing ServiceNow record as an interactive in-chat panel. Users can edit fields, change state, and add comments or work notes directly in the frame.",
      inputSchema: {
        table: z.string().describe("The ServiceNow table name"),
        id: z
          .string()
          .describe("The record sys_id or number (e.g. INC0010023)"),
      },
      _meta: { ui: { resourceUri: ticketResourceUri } },
    },
    async ({ table, id }) => {
      try {
        const [schema, record] = await Promise.all([
          getFormFields(table, token, customHeaders),
          getRecord(table, id, token, customHeaders),
        ]);
        const activity = await getActivity(
          table,
          record.sysId,
          token,
          customHeaders,
        );

        // Flatten record values for form seeding (raw values + display labels).
        const values: Record<string, string> = {};
        const displays: Record<string, string> = {};
        for (const [name, v] of Object.entries(record.values)) {
          values[name] = v.value;
          displays[name] = v.display;
        }

        const recordUrl = `${getInstanceUrl()}/nav_to.do?uri=${encodeURIComponent(
          `${table}.do?sys_id=${record.sysId}`,
        )}`;

        const renderData = {
          table,
          sysId: record.sysId,
          number: record.number ?? "",
          isTaskTable: schema.isTaskTable ?? false,
          fields: schema.fields,
          values,
          displays,
          activity,
          recordUrl,
        };

        let html = await getTicketHtml();
        html = html.replace(
          '<div class="ticket-container">',
          `<div class="ticket-container" data-ticket="${encodeForDataAttr(renderData)}">`,
        );
        html = html.replace(
          "</head>",
          `<script>window.TICKET_DATA = ${safeJsonForHtml(renderData)};</script></head>`,
        );

        return {
          content: [
            { type: "text", text: JSON.stringify(renderData) },
            {
              type: "resource",
              resource: {
                uri: ticketResourceUri,
                mimeType: RESOURCE_MIME_TYPE,
                text: html,
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

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`ServiceNow MCP Server running on port ${PORT}`);
  console.log(
    `OAuth endpoints: /.well-known/oauth-authorization-server, /register, /authorize, /token`,
  );
  console.log(`MCP endpoint: /mcp`);
});
