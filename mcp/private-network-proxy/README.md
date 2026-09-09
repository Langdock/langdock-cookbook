# Private-network MCP proxy

Langdock can only call a **public** Streamable HTTP MCP URL. A server that only
exists on an internal network fails from Langdock with “MCP server endpoint not
found” (or an HTML unavailable page from the host). This recipe is the
workaround: a small public proxy that allowlists Langdock’s egress IP and
forwards tool calls to the private MCP.

```
Langdock  --allowlisted IP-->  public proxy  -->  private MCP
```

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/)
- A public HTTPS URL in front of the proxy when you connect Langdock (load
  balancer, Container Apps, or a tunnel such as ngrok)

## Setup & run

```bash
cp .env.example .env
pnpm d
```

Locally this starts two processes in one Node runtime:

- a **dummy private MCP** on `127.0.0.1:3001` (`echo`, `get_note`)
- the **proxy** on `0.0.0.0:3000`, forwarding to that MCP

`127.0.0.1` is on the default allowlist so you can curl the proxy from the same
machine. Langdock cloud needs `4.185.103.44` — see
[Static IP configuration](https://docs.langdock.com/en/admin/security/static-ip-configuration).

```bash
# should fail if you point Langdock or a public client at the private MCP
curl -sS -X POST http://127.0.0.1:3001/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_note","arguments":{}}}'

# should succeed through the proxy from an allowlisted IP
curl -sS -X POST http://127.0.0.1:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_note","arguments":{}}}'
```

In production, set `PRIVATE_MCP_URL` to your real internal MCP, keep
`ALLOWED_IPS=4.185.103.44` (plus any CIDR you need), and put TLS in front of
`PORT`. Register only the proxy in Langdock:

1. Integrations → Add integration → Start from scratch → Connect remote MCP
2. URL: `https://<your-proxy-host>/mcp`
3. Authentication: none (add your own header later if you want)

A second integration pointed at the **private** MCP URL should fail. That is the
point.

## How it works

Langdock never gets a route into the private network. The proxy is the only
public hop. It:

1. Rejects callers whose IP is not on `ALLOWED_IPS` (`403`)
2. Forwards `POST /` and `POST /mcp` unchanged to `PRIVATE_MCP_URL`
3. Keeps a short in-memory log at `GET /calls` (allowlisted; lost on restart)

`GET /health` stays open for load-balancer probes.

This is not the product MCP gateway (tunneling / official allowlists in the
app). Auth such as OAuth can sit on the MCP or in front of this proxy — the IP
list is the network control.

| Path | Who | What |
| --- | --- | --- |
| `POST /mcp` | Langdock | Forward to the private MCP |
| `GET /health` | Load balancer | Always open, returns `ok` |
| `GET /calls` | Allowlisted IPs | Last ~200 requests |
