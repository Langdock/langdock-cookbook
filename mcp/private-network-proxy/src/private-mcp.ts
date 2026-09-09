import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PROTOCOL_VERSION = "2025-03-26";

function tools() {
  return [
    {
      name: "echo",
      description: "Echo text back. Proves a tool call reached this MCP.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "Text to echo" } },
        required: ["text"],
      },
    },
    {
      name: "get_note",
      description: "Return a static note that identifies the private MCP.",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

function handleJsonRpc(message: Record<string, unknown>, note: string, sessionId: string) {
  const id = message.id;
  if (id === undefined) {
    return { status: 202, body: null as unknown, sessionId };
  }

  const method = message.method;
  if (method === "initialize") {
    return {
      status: 200,
      sessionId,
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "private-mcp", version: "0.1.0" },
        },
      },
    };
  }
  if (method === "ping") {
    return { status: 200, sessionId, body: { jsonrpc: "2.0", id, result: {} } };
  }
  if (method === "tools/list") {
    return { status: 200, sessionId, body: { jsonrpc: "2.0", id, result: { tools: tools() } } };
  }
  if (method === "tools/call") {
    const params = (message.params ?? {}) as { name?: string; arguments?: { text?: string } };
    if (params.name === "echo") {
      const text = typeof params.arguments?.text === "string" ? params.arguments.text : "";
      return {
        status: 200,
        sessionId,
        body: {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify({ echo: text, source: "private-mcp" }) }] },
        },
      };
    }
    if (params.name === "get_note") {
      return {
        status: 200,
        sessionId,
        body: {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify({ note, source: "private-mcp" }) }] },
        },
      };
    }
    return {
      status: 200,
      sessionId,
      body: { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${params.name}` } },
    };
  }

  return {
    status: 200,
    sessionId,
    body: { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(method)}` } },
  };
}

export function createPrivateMcp(note = "Reached private-mcp. This process is not public.") {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok\n");
      return;
    }

    const isMcpPath = url.pathname === "/" || url.pathname === "/mcp";
    if (req.method === "POST" && isMcpPath) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") as Record<string, unknown>;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
        return;
      }

      const sessionId =
        typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : randomUUID();
      const handled = handleJsonRpc(message, note, sessionId);
      if (handled.status === 202) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(handled.status, {
        "content-type": "application/json",
        "mcp-session-id": handled.sessionId,
      });
      res.end(`${JSON.stringify(handled.body)}\n`);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });
}
