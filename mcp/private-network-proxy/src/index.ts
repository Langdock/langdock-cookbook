import "dotenv/config";
import { createPrivateMcp } from "./private-mcp.js";
import { createProxy, parseAllowlist } from "./proxy.js";

const proxyPort = Number(process.env.PORT ?? 3000);
const mcpPort = Number(process.env.PRIVATE_MCP_PORT ?? 3001);
const mcpUrl = (process.env.PRIVATE_MCP_URL ?? `http://127.0.0.1:${mcpPort}`).replace(/\/$/, "");
const allowlist = parseAllowlist(process.env.ALLOWED_IPS);

if (!Number.isInteger(proxyPort) || proxyPort < 1) {
  throw new Error("PORT must be a positive integer");
}
if (!Number.isInteger(mcpPort) || mcpPort < 1) {
  throw new Error("PRIVATE_MCP_PORT must be a positive integer");
}

const mcp = createPrivateMcp();
mcp.listen(mcpPort, "127.0.0.1", () => {
  console.log(`private-mcp listening on 127.0.0.1:${mcpPort} (loopback only)`);
});

const proxy = createProxy({ mcpUrl, allowlist });
proxy.listen(proxyPort, "0.0.0.0", () => {
  console.log(`proxy listening on 0.0.0.0:${proxyPort} mcp=${mcpUrl} allow=${allowlist.length}`);
});
