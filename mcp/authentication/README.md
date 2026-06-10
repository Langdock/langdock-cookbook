# MCP Authentication with Dynamic Client Registration

Two recipes showing how to put OAuth 2.0 in front of an MCP server, delegating
user authentication to an identity provider:

| Identity provider | Recipe |
|---|---|
| Okta | [`okta-dcr/`](okta-dcr/) |
| Microsoft Entra ID (Azure AD) | [`entra-dcr/`](entra-dcr/) |

Both follow the **same pattern** — only the provider-specific configuration
differs. Read this page once, then pick the recipe for your IdP.

## The pattern: an OAuth 2.0 proxy

The MCP server acts as an OAuth 2.0 **authorization server** to its clients while
delegating the actual user login to an upstream identity provider (Okta or Entra):

```
MCP client  ──(OAuth)──>  MCP server (proxy)  ──(OAuth)──>  Identity provider
                                │                                  │
                                └──── forwards the IdP token ───────┘
                                       to call downstream APIs
```

The client authenticates against the MCP server; the MCP server delegates to the
IdP for the actual user authentication, then uses the resulting IdP access token
to call APIs on the user's behalf.

## Why Dynamic Client Registration (DCR)?

MCP clients are not registered with your IdP ahead of time, and you don't want to
hand-configure a client ID/secret for every client that might connect.
[Dynamic Client Registration (RFC 7591)](https://datatracker.ietf.org/doc/html/rfc7591)
lets a client register itself with the authorization server **at runtime** and
receive credentials automatically — so any compliant MCP client can connect
without manual setup.

These recipes implement the registration endpoint so the MCP client can:

1. Discover the server's OAuth metadata.
2. Register itself dynamically (DCR) to obtain client credentials.
3. Run the standard authorization-code flow, with the MCP server brokering to the IdP.

## Pick your recipe

- **[`okta-dcr/`](okta-dcr/)** — delegating to Okta.
- **[`entra-dcr/`](entra-dcr/)** — delegating to Microsoft Entra ID (Azure AD),
  forwarding the Entra token to call Microsoft Graph.
