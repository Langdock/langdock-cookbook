# MCP Recipes

Recipes for building [Model Context Protocol](https://modelcontextprotocol.io)
servers, grouped by the problem they solve.

| Problem | Recipe | What it shows |
|---|---|---|
| **Authentication** | [`authentication/okta-dcr/`](authentication/okta-dcr/) | OAuth 2.0 delegating to **Okta**, with Dynamic Client Registration. |
| **Authentication** | [`authentication/entra-dcr/`](authentication/entra-dcr/) | OAuth 2.0 delegating to **Microsoft Entra ID**, with Dynamic Client Registration. |
| **Apps & UI** | [`apps/google-maps/`](apps/google-maps/) | Rendering an interactive, embedded UI (a live Google Map) inside the MCP client. |
| **Apps & UI** | [`apps/drawio/`](apps/drawio/) | Embedding an editable draw.io diagram editor inside the MCP client — no auth, fully client-side. |
| **Apps & UI** | [`apps/servicenow/`](apps/servicenow/) | An interactive record-creation form backed by ServiceNow, with OAuth + Dynamic Client Registration. |
| **File uploads** | [`file-uploads/`](file-uploads/) | Accepting file inputs and resolving Langdock file references into structured `FileData`. |

New to OAuth + Dynamic Client Registration for MCP? Start with the shared
explainer in [`authentication/`](authentication/) before diving into the Okta or
Entra recipe.
