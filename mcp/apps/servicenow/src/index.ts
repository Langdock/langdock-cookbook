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
  deleteAttachment,
  discoverTickets,
  getActivity,
  getAttachments,
  getFormFields,
  getRecord,
  getRecordWithTaskFallback,
  getTicketFields,
  submitForm,
  type TicketSummary,
  uploadAttachment,
  updateRecord,
} from "./servicenow/client.js";
import { encodeForDataAttr } from "./utils/encodeForDataAttr.js";
import { extractCustomHeaders } from "./utils/extractCustomHeaders.js";
import { getBaseUrl } from "./utils/getBaseUrl.js";
import { getFormHtml } from "./utils/getFormHtml.js";
import { getTicketHtml } from "./utils/getTicketHtml.js";
import { getTicketListHtml } from "./utils/getTicketListHtml.js";
import { getInstanceUrl } from "./utils/getInstanceUrl.js";
import { safeJsonForHtml } from "./utils/safeJsonForHtml.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// ---------------------------------------------------------------------------
// Express App Setup
// ---------------------------------------------------------------------------

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "12mb" }));
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

function formatTicketResults(
  tickets: TicketSummary[],
  warning?: string,
): string {
  if (tickets.length === 0) {
    return [
      "No ServiceNow tickets matched the filters.",
      warning,
    ].filter(Boolean).join("\n\n");
  }
  const escapeMarkdown = (value: string): string =>
    value.replace(/[\\[\]]/g, "\\$&").replace(/\s+/g, " ").trim();
  const rows = tickets.map((ticket) => {
    const label = escapeMarkdown(
      [ticket.number, ticket.shortDescription].filter(Boolean).join(" — ") ||
        "ServiceNow ticket",
    );
    const details = [
      ticket.state && `State: ${ticket.state}`,
      ticket.priority && `Priority: ${ticket.priority}`,
      ticket.severity && `Severity: ${ticket.severity}`,
      ticket.impact && `Impact: ${ticket.impact}`,
      ticket.assignedTo && `Assigned to: ${ticket.assignedTo}`,
    ].filter(Boolean);
    return `- [${label}](${ticket.recordUrl})${details.length ? ` — ${details.join("; ")}` : ""}`;
  });
  const summary = `Found ${tickets.length} ServiceNow ticket${tickets.length === 1 ? "" : "s"}:\n\n${rows.join("\n")}`;
  return [summary, warning].filter(Boolean).join("\n\n");
}

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
  const ticketListResourceUri = "ui://servicenow/ticket-list";

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

  registerAppResource(
    server,
    ticketListResourceUri,
    ticketListResourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: ticketListResourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await getTicketListHtml(),
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

  const filterValue = z.union([z.string(), z.array(z.string()).min(1)]);
  const dateRange = z
    .object({
      after: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/, "Use an ISO date or datetime")
        .optional(),
      before: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/, "Use an ISO date or datetime")
        .optional(),
    })
    .refine((range) => range.after || range.before, {
      message: "Provide at least one range boundary",
    });

  // Tool: Discover tickets without requiring a ServiceNow table name.
  registerAppTool(
    server,
    "discover_tickets",
    {
      title: "Discover Tickets",
      description:
        "Find ServiceNow tickets across task-derived records without asking the user for a table. Use related_user when a request says tickets “for” a person without specifying whether they are the caller, opener, or assignee; use the role-specific filters only when the role is explicit. Choice labels such as “1 - Critical” are accepted. Selecting a result opens its in-chat ticket panel, while a separate action opens ServiceNow.",
      inputSchema: {
        number: z.string().optional().describe("Exact ticket number"),
        short_description: z
          .string()
          .optional()
          .describe("Text contained in the short description"),
        state: filterValue.optional().describe("State value or label, or values/labels"),
        priority: filterValue
          .optional()
          .describe("Priority value or label, or values/labels"),
        impact: filterValue
          .optional()
          .describe("Impact value or label, or values/labels"),
        urgency: filterValue
          .optional()
          .describe("Urgency value or label, or values/labels"),
        severity: filterValue
          .optional()
          .describe("Severity value or label, or values/labels"),
        category: filterValue.optional().describe("Category name or names"),
        related_user: filterValue
          .optional()
          .describe(
            "Cross-role person filter. Matches caller, opened by, OR assigned to. Use when the user says tickets “for”, “related to”, or “involving” a person without naming a specific relationship.",
          ),
        caller: filterValue
          .optional()
          .describe(
            "Caller display name or names. Use only when the request explicitly says caller or requester; otherwise use related_user.",
          ),
        assigned_to: filterValue
          .optional()
          .describe(
            'Assignee display name or names. Use only when the request explicitly says assigned to, owned by, or assignee. Use "me" for the authenticated ServiceNow user.',
          ),
        assigned_to_me: z
          .boolean()
          .optional()
          .describe(
            "Only tickets assigned to the authenticated ServiceNow user. Use for “my assigned tickets”, not tickets merely opened by or involving the user. Defaults to active unless state or active is specified.",
          ),
        assignment_group: filterValue
          .optional()
          .describe(
            "Assignment group display name or names. This filters the responsible group, not an individual user.",
          ),
        configuration_item: filterValue
          .optional()
          .describe("Configuration item display name or names"),
        opened_by: filterValue
          .optional()
          .describe(
            "Opened-by display name or names. Use only when the request explicitly says opened by or created by; otherwise use related_user.",
          ),
        active: z.boolean().optional().describe("Whether the ticket is active"),
        opened_at: dateRange.optional().describe("Opened date/time range"),
        closed_at: dateRange.optional().describe("Closed date/time range"),
        created_at: dateRange.optional().describe("Created date/time range"),
        updated_at: dateRange.optional().describe("Last-updated date/time range"),
        additional_filters: z
          .record(z.string(), filterValue)
          .optional()
          .describe(
            "Extra exact-match field filters, keyed by a ServiceNow field name. Do not use an encoded query.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum number of results, default 25"),
        order_by: z
          .enum([
            "priority",
            "severity",
            "impact",
            "urgency",
            "state",
            "opened_at",
            "updated_at",
            "created_at",
          ])
          .optional()
          .describe(
            "Field to sort by. Defaults to triage order: priority, impact, then oldest opened.",
          ),
        order_direction: z
          .enum(["asc", "desc"])
          .optional()
          .describe(
            "Sort direction. Defaults to ascending for ranking fields and descending for dates.",
          ),
        group_by: z
          .enum(["none", "state", "type", "assignment_group"])
          .optional()
          .describe("Optional visual grouping for the rendered ticket list"),
      },
      _meta: { ui: { resourceUri: ticketListResourceUri } },
    },
    async ({
      number,
      short_description,
      state,
      priority,
      impact,
      urgency,
      severity,
      category,
      related_user,
      caller,
      assigned_to,
      assigned_to_me,
      assignment_group,
      configuration_item,
      opened_by,
      active,
      opened_at,
      closed_at,
      created_at,
      updated_at,
      additional_filters,
      limit,
      order_by,
      order_direction,
      group_by,
    }) => {
      try {
        const assignedToValues =
          assigned_to == null
            ? []
            : Array.isArray(assigned_to)
              ? assigned_to
              : [assigned_to];
        const isMyTickets =
          assigned_to_me ||
          assignedToValues.some((value) =>
            /^(me|myself|current user)$/i.test(value.trim()),
          );
        const effectiveActive =
          active ?? (isMyTickets && state == null ? true : undefined);
        const result = await discoverTickets(
          {
            number,
            shortDescription: short_description,
            state,
            priority,
            impact,
            urgency,
            severity,
            category,
            relatedUser: related_user,
            caller,
            assignedTo: assigned_to,
            assignedToMe: assigned_to_me,
            assignmentGroup: assignment_group,
            configurationItem: configuration_item,
            openedBy: opened_by,
            active: effectiveActive,
            openedAt: opened_at,
            closedAt: closed_at,
            createdAt: created_at,
            updatedAt: updated_at,
            additionalFilters: additional_filters,
          },
          token,
          customHeaders,
          {
            limit,
            sortBy: order_by,
            sortDirection: order_direction,
          },
        );
        // Warm the per-user schema cache while the user scans the list. This
        // removes the slowest metadata work from most subsequent card clicks.
        const resultTables = [
          ...new Set(result.tickets.map((ticket) => ticket.table)),
        ].slice(0, 5);
        void Promise.allSettled(
          resultTables.map((resultTable) =>
            getTicketFields(resultTable, token, customHeaders),
          ),
        );
        const displayFilter = (
          label: string,
          value: string | string[] | undefined,
        ): string | null => {
          if (value == null) return null;
          const values = Array.isArray(value) ? value : [value];
          return `${label}: ${values.join(", ")}`;
        };
        const displayDateRange = (
          label: string,
          range: { after?: string; before?: string } | undefined,
        ): string | null => {
          if (!range) return null;
          if (range.after && range.before) {
            return `${label}: ${range.after} to ${range.before}`;
          }
          return range.after
            ? `${label}: after ${range.after}`
            : `${label}: before ${range.before}`;
        };
        const filterSummary = [
          assigned_to_me ? "Assigned to me" : displayFilter("Assigned to", assigned_to),
          displayFilter("Related user", related_user),
          displayFilter("Assignment group", assignment_group),
          displayFilter("Caller", caller),
          displayFilter("Configuration item", configuration_item),
          displayFilter("Opened by", opened_by),
          displayFilter("State", state),
          displayFilter("Priority", priority),
          displayFilter("Severity", severity),
          displayFilter("Impact", impact),
          displayFilter("Urgency", urgency),
          displayFilter("Category", category),
          effectiveActive == null
            ? null
            : `Active: ${effectiveActive ? "Yes" : "No"}`,
          short_description
            ? `Description contains: ${short_description}`
            : null,
          displayDateRange("Opened", opened_at),
          displayDateRange("Closed", closed_at),
          displayDateRange("Created", created_at),
          displayDateRange("Updated", updated_at),
        ].filter((value): value is string => Boolean(value));
        const defaultDirection = order_by
          ? ["opened_at", "updated_at", "created_at"].includes(order_by)
            ? "desc"
            : "asc"
          : null;
        const warning = result.truncated
          ? `Choice filtering reached its ${result.scanned}-record scan limit. These results are accurate but may be incomplete; add an assignment, date, active, or text filter to narrow the search.`
          : undefined;
        const renderData = {
          title: "ServiceNow tickets",
          tickets: result.tickets,
          filterSummary,
          groupBy: group_by || "none",
          warning,
          sortLabel: order_by
            ? `${order_by.replaceAll("_", " ")} ${order_direction || defaultDirection}`
            : "priority, impact, oldest opened",
        };
        let html = await getTicketListHtml();
        html = html.replace(
          '<div class="ticket-list-container">',
          `<div class="ticket-list-container" data-tickets="${encodeForDataAttr(renderData)}">`,
        );
        html = html.replace(
          "</head>",
          `<script>window.TICKET_LIST_DATA = ${safeJsonForHtml(renderData)};</script></head>`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: formatTicketResults(result.tickets, warning),
            },
            {
              type: "resource" as const,
              resource: {
                uri: ticketListResourceUri,
                mimeType: RESOURCE_MIME_TYPE,
                text: html,
              },
            },
          ],
          _meta: { "mcpui.dev/ui-initial-render-data": renderData },
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
        activity_table: z
          .string()
          .optional()
          .describe(
            "Concrete table used to reload activity when updates use a parent table",
          ),
        sys_id: z.string().describe("The sys_id of the record"),
        field: z
          .enum(["comments", "work_notes"])
          .describe("Which journal field to append to"),
        text: z.string().describe("The comment or work note text"),
      },
    },
    async ({ table, activity_table, sys_id, field, text }) => {
      try {
        await updateRecord(
          table,
          sys_id,
          { [field]: text },
          token,
          customHeaders,
        );
        const activity = await getActivity(
          activity_table || table,
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

  registerAppTool(
    server,
    "upload_attachment",
    {
      title: "Upload Ticket Attachment",
      description:
        "Attach a file of up to 8 MB to a ServiceNow ticket. The ticket panel calls this tool with base64 file data.",
      inputSchema: {
        table: z.string().describe("The ticket's concrete ServiceNow table"),
        sys_id: z.string().describe("The ticket sys_id"),
        file_name: z.string().min(1).max(255).describe("Original file name"),
        content_type: z
          .string()
          .optional()
          .describe("File MIME type, if known"),
        data_base64: z
          .string()
          .min(1)
          .max(12_000_000)
          .describe("Base64-encoded file bytes"),
      },
      annotations: { openWorldHint: true },
      _meta: {
        ui: {
          resourceUri: ticketResourceUri,
          visibility: ["app"],
        },
      },
    },
    async ({ table, sys_id, file_name, content_type, data_base64 }) => {
      try {
        await uploadAttachment(
          table,
          sys_id,
          file_name,
          content_type || "application/octet-stream",
          data_base64,
          token,
          customHeaders,
        );
        const attachments = await getAttachments(
          table,
          sys_id,
          token,
          customHeaders,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ attachments }, null, 2),
            },
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

  registerAppTool(
    server,
    "delete_attachment",
    {
      title: "Delete Ticket Attachment",
      description: "Permanently delete a file attached to a ServiceNow ticket.",
      inputSchema: {
        table: z.string().describe("The ticket's concrete ServiceNow table"),
        table_sys_id: z.string().describe("The ticket sys_id"),
        sys_id: z.string().describe("The attachment sys_id"),
      },
      annotations: { destructiveHint: true },
      _meta: {
        ui: {
          resourceUri: ticketResourceUri,
          visibility: ["app"],
        },
      },
    },
    async ({ table, table_sys_id, sys_id }) => {
      try {
        await deleteAttachment(
          table,
          table_sys_id,
          sys_id,
          token,
          customHeaders,
        );
        const attachments = await getAttachments(
          table,
          table_sys_id,
          token,
          customHeaders,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ attachments }, null, 2),
            },
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
        "Open an existing ServiceNow ticket as an interactive in-chat panel. A table is optional: when omitted, the server discovers the ticket's concrete task type automatically. Users can edit fields, change state, work with attachments, and add comments or work notes directly in the frame.",
      inputSchema: {
        table: z
          .string()
          .optional()
          .describe(
            "Optional ServiceNow table name. Omit this for a ticket discovered through discover_tickets.",
          ),
        id: z
          .string()
          .describe("The record sys_id or number (e.g. INC0010023)"),
      },
      _meta: { ui: { resourceUri: ticketResourceUri } },
    },
    async ({ table, id }) => {
      try {
        let resolvedTable: string;
        let recordTable: string;
        let schema: Awaited<ReturnType<typeof getTicketFields>>;
        let record: Awaited<ReturnType<typeof getRecord>>;
        let activity: Awaited<ReturnType<typeof getActivity>>;
        let attachments: Awaited<ReturnType<typeof getAttachments>>;
        const idIsSysId = /^[0-9a-f]{32}$/i.test(id.trim());

        if (table && idIsSysId) {
          // Discovery cards already provide the concrete table and sys_id, so
          // record, activity, and attachment requests can run concurrently.
          resolvedTable = table;
          const [recordResult, loadedActivity, loadedAttachments] =
            await Promise.all([
              getRecordWithTaskFallback(
                table,
                id,
                token,
                customHeaders,
              ),
              getActivity(table, id, token, customHeaders),
              getAttachments(table, id, token, customHeaders),
            ]);
          record = recordResult.record;
          recordTable = recordResult.recordTable;
          activity = loadedActivity;
          attachments = loadedAttachments;
          schema = await getTicketFields(
            recordTable,
            token,
            customHeaders,
          );
        } else if (table) {
          resolvedTable = table;
          const recordResult = await getRecordWithTaskFallback(
            table,
            id,
            token,
            customHeaders,
          );
          record = recordResult.record;
          recordTable = recordResult.recordTable;
          [schema, activity, attachments] = await Promise.all([
            getTicketFields(recordTable, token, customHeaders),
            getActivity(table, record.sysId, token, customHeaders),
            getAttachments(table, record.sysId, token, customHeaders),
          ]);
        } else {
          const initialRecord = await getRecord(
            "task",
            id,
            token,
            customHeaders,
          );
          resolvedTable =
            initialRecord.values.sys_class_name?.value || "task";
          const recordResult =
            resolvedTable === "task"
              ? { record: initialRecord, recordTable: "task" }
              : await getRecordWithTaskFallback(
                  resolvedTable,
                  initialRecord.sysId,
                  token,
                  customHeaders,
                );
          record = recordResult.record;
          recordTable = recordResult.recordTable;
          [schema, activity, attachments] = await Promise.all([
            getTicketFields(recordTable, token, customHeaders),
            getActivity(
              resolvedTable,
              record.sysId,
              token,
              customHeaders,
            ),
            getAttachments(
              resolvedTable,
              record.sysId,
              token,
              customHeaders,
            ),
          ]);
        }

        // Flatten record values for form seeding (raw values + display labels).
        const values: Record<string, string> = {};
        const displays: Record<string, string> = {};
        for (const [name, v] of Object.entries(record.values)) {
          values[name] = v.value;
          displays[name] = v.display;
        }

        const recordUrl = `${getInstanceUrl()}/nav_to.do?uri=${encodeURIComponent(
          `${resolvedTable}.do?sys_id=${record.sysId}`,
        )}`;

        const renderData = {
          table: resolvedTable,
          recordTable,
          sysId: record.sysId,
          number: record.number ?? "",
          isTaskTable: schema.isTaskTable ?? false,
          fields: schema.fields,
          values,
          displays,
          activity,
          attachments,
          recordUrl,
          accessNotice:
            recordTable !== resolvedTable
              ? `This ticket is opened through the parent task API because ServiceNow denied direct API access to ${resolvedTable}. Only inherited task fields are editable.`
              : undefined,
        };

        let html = await getTicketHtml();
        html = html.replace(
          "</head>",
          `<script>window.TICKET_DATA = ${safeJsonForHtml(renderData)};</script></head>`,
        );

        return {
          content: [
            {
              type: "text",
              text: `Opened ${record.number || record.sysId} from ${resolvedTable}.`,
            },
            {
              type: "resource",
              resource: {
                uri: ticketResourceUri,
                mimeType: RESOURCE_MIME_TYPE,
                text: html,
              },
            },
          ],
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
