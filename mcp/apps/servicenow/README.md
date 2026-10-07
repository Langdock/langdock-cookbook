# servicenow-mcp-server

An MCP (Model Context Protocol) server for **ServiceNow** with interactive, in-chat UI for both **creating** and **working** records.

It can:

- Inspect a ServiceNow table's fields and render an editable **creation form** right inside the client (optionally pre-filled from the conversation), then submit it as a new record.
- **Discover tickets** across task-derived records using user-facing filters such as state, severity, impact, assignment, and date ranges — without asking the user to identify a ServiceNow table — then open any result in the interactive ticket panel.
- **Open an existing record** (e.g. an incident) as an interactive **ticket panel** inside the client, where users can edit fields, change state, upload/download/delete attachments, and add comments or work notes — each change saved straight back to ServiceNow without leaving the chat.
- **Watch a ticket in the background** as an [MCP Task](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks): the server reports each change as a task status update and hands a summary of everything that happened back to the model once the ticket is resolved, gets a reply, or whatever stop condition was asked for.
- **Chat with ServiceNow Otto in the same frame.** The ticket list and the ticket panel both have an *Ask Otto* view that talks to Otto (Virtual Agent with Now Assist) as the signed-in user. Ticket numbers in Otto's answers open in the same frame, and the conversation carries over as you move between results, tickets, and chat. See [Otto chat](#otto-chat).

The server acts as an OAuth 2.0 proxy with Dynamic Client Registration (DCR): MCP clients authenticate through this server, which delegates user sign-in to your ServiceNow instance and forwards the ServiceNow access token on every API call.

The ticket panel is **generic but ticket-aware**: it works for any table, and for tables that extend `task` (incident, `sc_task`, change, problem, …) it adds ticket-specific niceties — a state badge, an activity/journal stream, and a comment/work-note composer.

> **ServiceNow instance compatibility:** The discovery filters and interactive ticket fields in this recipe are configured for a standard ServiceNow Personal Developer Instance. They can be adapted to any ServiceNow instance, but teams adopting the recipe may need to customize its table and field mappings, choice values, and permissions to match their instance.

## OAuth Flow

MCP clients authenticate through this server, which delegates to ServiceNow for user authentication:

```
MCP Client                    This Server                  ServiceNow
    │                              │                           │
    ├─ Discover OAuth metadata ──► │                           │
    │  (/.well-known/oauth-        │                           │
    │   authorization-server)      │                           │
    │                              │                           │
    ├─ Register via DCR ─────────► │                           │
    │  (POST /register)            │                           │
    │                              │                           │
    ├─ Authorize (with PKCE) ────► │                           │
    │  (GET /authorize)            ├─ Redirect to ServiceNow ► │
    │                              │  (/oauth_auth.do)         │
    │                              │                           │
    │                              │  ◄── User authenticates ──┤
    │                              │                           │
    │                              │  ◄── Callback with code ──┤
    │                              │  (GET /oauth/callback)    │
    │                              │                           │
    │  ◄── Redirect with code ─────┤                           │
    │                              │                           │
    ├─ Exchange code for token ──► │                           │
    │  (POST /token)               ├─ Exchange code for ──────►│
    │                              │  ServiceNow tokens        │
    │                              │  (POST /oauth_token.do)   │
    │                              │                           │
    ├─ Use token for MCP ────────► │                           │
    │  (POST /mcp)                 ├─ Call ServiceNow Table ──►│
    │                              │  API                      │
    │                              │                           │
```

ServiceNow enforces PKCE, so the server sets `skipLocalPkceValidation` and lets ServiceNow validate the `code_verifier`.

## Prerequisites

- Node.js 18+
- pnpm
- A ServiceNow instance with an **OAuth API endpoint for external clients** (**System OAuth → Application Registry**):
  - Redirect URL set to `<BASE_URL>/oauth/callback`
  - Client ID (and Client Secret, for confidential clients)

## Setup

1. Install:

```bash
pnpm install
```

2. Configure environment:

```bash
export SERVICENOW_INSTANCE="dev12345"            # subdomain or full host (dev12345.service-now.com)
export SERVICENOW_CLIENT_ID="your-client-id"
export BASE_URL="http://localhost:3000"          # public URL; must match the OAuth redirect URL
# Optional — language used for form choice options (default: en):
# export SERVICENOW_LANGUAGE="en"
# Optional — maximum records inspected for cross-table choice filters:
# export SERVICENOW_DISCOVERY_SCAN_LIMIT="5000"
# Optional — how often watch_ticket polls a watched ticket (default: 10):
# export SERVICENOW_WATCH_POLL_SECONDS="10"
# Optional — turns on the Otto chat (see "Otto chat" below):
# export SERVICENOW_VA_CALLBACK_SECRET="long-random-string"
# export SERVICENOW_VA_TOKEN="static-message-auth-token"
# Optional — only for confidential OAuth clients:
# export SERVICENOW_CLIENT_SECRET="your-client-secret"
```

3. Build and run:

```bash
pnpm dev
```

The server starts on port `3000` and exposes the MCP endpoint at `/mcp`.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SERVICENOW_INSTANCE` | Yes | Instance subdomain (`dev12345`) or full host (`dev12345.service-now.com`) |
| `SERVICENOW_CLIENT_ID` | Yes | OAuth client ID from the ServiceNow Application Registry |
| `BASE_URL` | Yes | Public base URL of this server; used to build the OAuth callback URL |
| `SERVICENOW_CLIENT_SECRET` | No | OAuth client secret — set only for confidential clients |
| `SERVICENOW_LANGUAGE` | No | Language used for form choice options (default: `en`) |
| `SERVICENOW_DISCOVERY_SCAN_LIMIT` | No | Maximum candidate records inspected for cross-table choice filters (default: `5000`) |
| `SERVICENOW_WATCH_POLL_SECONDS` | No | How often `watch_ticket` polls a watched ticket (default: `10`) |
| `SERVICENOW_VA_CALLBACK_SECRET` | No | Turns on the Otto chat. ServiceNow must send it on every reply to `/servicenow/va/callback`, as an `x-otto-callback-secret` header or a Bearer token |
| `SERVICENOW_VA_TOKEN` | No | Static Message Authentication token for the Virtual Agent API, sent as the `token` header. Without it, Virtual Agent treats every user as a guest |
| `PORT` | No | Port to listen on (default: `3000`) |

## Endpoints

| Endpoint | Description |
|---|---|
| `/.well-known/oauth-authorization-server` | OAuth 2.0 authorization server metadata |
| `/register` | Dynamic Client Registration (RFC 7591) |
| `/authorize` | Authorization endpoint (redirects to ServiceNow) |
| `/token` | Token endpoint |
| `/oauth/callback` | ServiceNow OAuth callback |
| `/mcp` | MCP endpoint (GET, POST, DELETE) — requires a Bearer token |
| `/servicenow/va/callback` | Virtual Agent API response endpoint for Otto replies (only when `SERVICENOW_VA_CALLBACK_SECRET` is set) |
| `/health` | Health check |

## MCP Tools

### `get_form_fields`

Get the available fields for a ServiceNow table.

**Parameters:** `table` (required) — the table name, e.g. `incident`.

### `render_form`

Display an interactive form to create a ServiceNow record. Fetches the table's fields and renders them as an editable form; the LLM can pre-fill values it extracted from the conversation.

**Parameters:** `table` (required), `prefill` (optional) — key-value pairs (string/number/boolean) used to pre-populate fields.

```json
{
  "table": "incident",
  "prefill": {
    "short_description": "Laptop won't turn on",
    "urgency": "2"
  }
}
```

### `update_form`

Update fields in a form that `render_form` already rendered, without opening a new iframe.

**Parameters:** `table` (required), `prefill` (required) — key-value pairs to update in the existing form.

```json
{
  "table": "incident",
  "prefill": {
    "urgency": "1"
  }
}
```

### `submit_form`

Submit a record to a ServiceNow table via the Table API.

**Parameters:** `table` (required), `data` (required) — the field values for the new record.

### `get_record`

Fetch a single existing record by `sys_id` or by its human-readable number (e.g. `INC0010023`). Values come back with both raw values and display labels.

**Parameters:** `table` (required), `id` (required) — a `sys_id` or number.

### `discover_tickets`

Find tickets across the `task` hierarchy without requiring a table name. Results
are returned as inline links and rendered in an interactive list; selecting a
card opens the editable ticket panel in the same App, with a back action that
preserves the search results. A separate action opens the actual record in
ServiceNow.

Use the named filters instead of an encoded query. The tool supports the fields
shown in the ticket panel: `state`, `priority`, `impact`, `urgency`, `severity`,
`category`, `caller`, `assigned_to`, `assignment_group`, `configuration_item`,
`opened_by`, and opened/closed date ranges. It also supports ticket number,
short-description text, active status, `assigned_to_me` or
`"assigned_to": "me"` for “my tickets”, created/updated ranges, bounded result
limits, and exact-match `additional_filters` for other fields. Choice labels
such as `1 - Critical` are accepted as well as their stored values.
“My tickets” searches default to active records unless a state or explicit
`active` value is supplied.

Choice filters are checked against each record's raw value and display label,
so table-specific state values do not get mixed together. On very large result
sets, discovery reports when it reaches `SERVICENOW_DISCOVERY_SCAN_LIMIT`;
adding an assignment, date, active, or text filter narrows that scan.

For requests such as “tickets for ITIL User” where the user’s role is not
specified, use `related_user`. It matches the person across caller, opened-by,
and assignee fields while preserving all other filters. Use `caller`,
`opened_by`, or `assigned_to` only when that relationship is explicit.

Discovery defaults to a triage-oriented order: priority, impact, then oldest
opened ticket. Use `order_by` and `order_direction` to sort by priority,
severity, impact, urgency, state, or ticket dates. The rendered list can also
use `group_by` to group results by state, ticket type, or assignment group. It
uses colored ranking/state badges, relative ticket ages, and a summary of the
active filters.

```json
{
  "severity": "1 - Critical",
  "state": "Closed",
  "impact": "1 - High",
  "assigned_to": "Charlie Witherspoon",
  "limit": 25
}
```

### `render_ticket`

Open an existing record as an **interactive ticket panel** inside the client. Fetches the record, its field schema, attachments, and comment/work-note activity, then renders an editable panel. Users can edit fields, change state, upload files up to 8 MB, open/download and delete attachments, and post comments or work notes directly in the frame.

Attachment operations are available only inside the interactive panel. Upload
and delete use app-only helpers that are not exposed as model-callable MCP
tools; downloads open ServiceNow's standard attachment URL through the host.

If ServiceNow permits discovery through `task` but denies direct Table API
access to a concrete child table, the panel falls back to the parent `task`
endpoint and exposes only inherited task fields for editing.

**Parameters:** `id` (required) — a `sys_id` or number; `table` (optional) —
the tool detects the concrete task type when it is omitted.

```json
{
  "table": "incident",
  "id": "INC0010023"
}
```

### `update_record`

Update field values on an existing record via `PATCH`. Called by the ticket panel when the user saves edits, and available to the model directly.

**Parameters:** `table` (required), `sys_id` (required), `data` (required) — the field values to change.

### `add_journal_entry`

Append a **comment** (customer-visible) or **work note** (internal) to a record's activity stream, and return the refreshed activity. Called by the ticket panel's composer.

**Parameters:** `table` (required), `sys_id` (required), `field` (`comments` | `work_notes`), `text` (required).

### `watch_ticket`

Watch a ticket in the background and report back when it changes. The tool
runs as an MCP task (`execution.taskSupport: "optional"`), so the model can
start it for requests like “tell me when INC0010023 is resolved” and keep
talking with the user while it runs.

**Parameters:** `id` (required) — a `sys_id` or number; `table` (optional) —
detected automatically when omitted; `until` (optional) — `any_update`
(default), `state_change`, `new_activity` (a new comment or work note), or
`resolved_or_closed`; `target_state` (optional) — stop once the state matches
one of these values or labels, takes precedence over `until`;
`timeout_minutes` (optional, 1–30, default 10).

```json
{
  "id": "INC0010023",
  "target_state": "Resolved",
  "timeout_minutes": 30
}
```

While the watch runs, every change it sees (state, priority, assignee,
assignment group, short description, new comments and work notes) becomes the
task's `statusMessage`. The final result lists each observed change with its
timestamp and author, plus the ticket's current values and a link to it.

### `open_otto_chat`

Open the Otto chat in the ServiceNow frame, for requests like “ask Otto how
to get VPN access” or “ask Otto about INC0010023”. With `message`, the
question goes to Otto right away and the frame opens on the running
conversation. With `ticket`, Otto gets that ticket as context.

**Parameters:** `message` (optional) — the user's first question; `ticket`
(optional) — a number or `sys_id`; `table` (optional) — detected when
omitted.

```json
{
  "ticket": "INC0010023",
  "message": "Is there a known fix for this?"
}
```

The chat itself runs on two app-only helpers that the model never sees:
`otto_send` posts a message as the signed-in user, and `otto_poll`
long-polls for Otto's replies.

## MCP Tasks

`watch_ticket` uses the experimental
[Tasks utility](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
from the 2025-11-25 MCP spec, via the SDK's
`server.experimental.tasks.registerToolTask`. The server advertises the
`tasks` capability with `tools/call`, `tasks/list`, and `tasks/cancel`.

```
MCP Client                         This Server                    ServiceNow
    │                                   │                              │
    ├─ tools/call watch_ticket ───────► │                              │
    │  (params.task = { ttl })          ├─ Load ticket ──────────────► │
    │  ◄── CreateTaskResult (working) ──┤                              │
    │                                   │                              │
    │                                   ├─ Poll every 10 s ──────────► │
    ├─ tasks/get ─────────────────────► │  (in the background)         │
    │  ◄── statusMessage: latest change ┤                              │
    │                                   │                              │
    ├─ tasks/result ──────────────────► │  stop condition met          │
    │  ◄── summary of all changes ──────┤                              │
```

How it fits this stateless server:

- **Shared task state.** Every HTTP request builds a new `McpServer`, so
  tasks live in one `TaskRegistry` that each request's server shares. The
  background poll writes to the registry directly; the request that started
  it is long gone.
- **Tasks are scoped per user.** The SDK's `InMemoryTaskStore` ignores session
  IDs and lists every task to every caller. Here each request gets a view of
  the registry bound to the ServiceNow user behind its bearer token, so
  `tasks/get`, `tasks/result`, `tasks/list`, and `tasks/cancel` only ever see
  that user's tasks.
- **Token refresh.** The watch polls with the user's own token. When the
  client refreshes its token and polls the task again, the watch switches to
  the new token. Watches are capped at 30 minutes, the default ServiceNow
  access-token lifespan; if the session expires anyway, the task fails with a
  reconnect hint.
- **Clients without task support.** If a `tools/call` has no `task`
  parameter, the SDK waits for the task inside that request. Because MCP
  clients usually time out a request after 60 seconds, those callers get a
  40-second watch and a result telling the model to call again.
- **Cancellation.** `tasks/cancel` stops the background poll immediately.

## Otto chat

Otto lives inside the frames the app already renders. There is no separate
chat resource:

- The **ticket list** has an *Ask Otto* button that swaps the results for the
  chat, with *← Results* to go back.
- The **ticket panel** has *Details* and *Ask Otto* tabs. Otto gets the open
  ticket as context: the first message about a ticket starts with
  “I have a question about INC0010023 ("…")”, and the ticket number, table,
  and `sys_id` are sent as `contextVariables` for topics that want them.
- **Ticket numbers** and record cards in Otto's answers open the ticket in the
  same frame. Its back link returns to the chat, and the conversation follows
  along: the frame passes the conversation ID with each in-frame navigation,
  and the transcript is kept on the server, so every view rebuilds it.

Otto talks to the
[Virtual Agent API](https://github.com/ServiceNow/ServiceNowDocs/blob/australia/markdown/api-reference/rest-apis/bot-api.md)
(`sn_va_as_service`), which only supports Otto in asynchronous mode. Replies
arrive on a callback, not in the HTTP response:

```
Frame                      This Server                       ServiceNow
  │                             │                                 │
  ├─ otto_send ───────────────► ├─ POST /api/sn_va_as_service/ ──► │
  │  ◄── your message ──────────┤  bot/integration (as the user)  │
  │                             │                                 │
  ├─ otto_poll (long poll) ───► │  ◄── POST /servicenow/va/ ───────┤
  │  ◄── AI steps, stream, ─────┤      callback (progress,        │
  │      answer, options        │      stream chunks, answer)     │
```

What the frame renders: text with citations as source chips, streamed
answers, the "View AI Steps" progress list, option pickers as buttons, links,
record cards, sanitized HTML tables, date/time and masked inputs, and
live-agent handoff with the agent's name. *Talk to a person* switches to a
live agent, and *End chat* ends the conversation. After each reply, the frame
sends the latest messages to the host with `ui/update-model-context`. Hosts
that support it can then answer “what did Otto say?” in the main chat.

Identity and security:

- **Otto acts as the signed-in user.** `userId` and `emailId` come from the
  `sys_user` record behind the caller's own OAuth token, never from tool
  input. Virtual Agent links the conversation to that ServiceNow account by
  email.
- **Conversations are private.** A conversation belongs to the ServiceNow user
  who started it. Other users get “not found”, and a refreshed token for the
  same user keeps access.
- **Callbacks are authenticated.** `/servicenow/va/callback` rejects any
  request without `SERVICENOW_VA_CALLBACK_SECRET`, and only applies a reply to
  the conversation whose user matches the reply's `userId`.
- **Untrusted content stays inert.** HTML replies go through an allowlist
  sanitizer, and links only open through the host as `http(s)` URLs.

### ServiceNow setup

Admins configure this once per instance:

1. Install the **Virtual Agent API** (`sn_va_as_service`, v4.1 or later for
   Otto streaming and AI steps).
2. **Inbound authentication.** Under *Scripted REST APIs → VA Bot Integration
   → BOT Integration*, require authentication. Then set up
   [Message Authentication](https://github.com/ServiceNow/ServiceNowDocs/blob/australia/markdown/conversational-interfaces/virtual-agent/set-up-message-auth-va-api.md)
   with a **Static token** and put that token in `SERVICENOW_VA_TOKEN`.
   OAuth alone makes every conversation a guest conversation. The server sends
   the static token and the user's own bearer token on every call.
3. **Response endpoint.** In
   [Bot to Bot Outbound Configurations → VA Bot to Bot Provider Application → Rest connection → Bot Connection](https://github.com/ServiceNow/ServiceNowDocs/blob/australia/markdown/conversational-interfaces/virtual-agent/configure-response-endpoint-auth-va-api.md),
   set the Connection URL to `<BASE_URL>/servicenow/va/callback`. Under
   *Attributes*, add the header `x-otto-callback-secret` with the value of
   `SERVICENOW_VA_CALLBACK_SECRET`.
4. **Otto.** Follow
   [Enable ServiceNow Otto experience in Virtual Agent API](https://github.com/ServiceNow/ServiceNowDocs/blob/australia/markdown/conversational-interfaces/virtual-agent/enable-now-assist-in-virtual-agent-experience-in-virtual-agent-api.md)
   to link the VA Bot to Bot provider channel to *ServiceNow Otto for Virtual
   Agent*. For streamed answers, also turn on *Allow response streaming* and
   set *Streaming Ready* for the Bot to Bot device in
   `sys_now_assist_channel_config`.

If a reply never arrives, the frame shows a notice after 90 seconds. Check
the response endpoint first: ServiceNow has to reach `BASE_URL` over HTTPS.
ServiceNow closes Bot to Bot conversations after an hour without activity,
and typing again simply starts a new one in the same thread.

## Resources

### `ui://servicenow/form`

The interactive creation form rendered by the `render_form` tool, served as an MCP App resource.

### `ui://servicenow/ticket`

The interactive ticket panel rendered by the `render_ticket` tool, served as an MCP App resource. Includes the *Ask Otto* tab when Otto is configured.

### `ui://servicenow/ticket-list`

The interactive ticket-discovery result list rendered by `discover_tickets`, and the chat frame rendered by `open_otto_chat`. Both pages load the shared chat module from `src/ui/otto-chat.html`, which the server inlines at the `<!-- otto-chat -->` placeholder.

## Client Configuration

```json
{
  "mcpServers": {
    "servicenow": {
      "type": "streamable-http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

For a deployed server, replace the URL with your public endpoint, e.g. `https://your-app.up.railway.app/mcp`.

## Deployment

Deploy the built `dist/` to any HTTPS host (Railway, Fly, Render, etc.) and set `BASE_URL` to the server's public URL so OAuth callbacks resolve. The `/authorize` route is handled directly (before `mcpAuthRouter`) to bypass the SDK's `redirect_uri` validation, which would otherwise require persistent client storage.

> **Note:** OAuth client and session state, MCP task state, and Otto conversations are held in memory. For production, back them with a persistent store (e.g. Redis or PostgreSQL) so registrations, in-flight authorizations, running watches, and chat transcripts survive restarts. Until then, run a single replica so `tasks/get` and Otto callbacks reach the instance that owns the task or conversation.
