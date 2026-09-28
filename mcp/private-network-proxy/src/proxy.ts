import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const MAX_STORED_CALLS = 200;
const BODY_LIMIT = 16_384;

export type Cidr = { ip: string; prefix: number };
export type StoredCall = {
  at: string;
  ip: string;
  method: string;
  path: string;
  allowed: boolean;
  request?: string;
  upstreamStatus?: number;
  response?: string;
};

export function parseAllowlist(raw: string | undefined): Cidr[] {
  if (!raw || !raw.trim()) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((value) => {
      if (value.includes("/")) {
        const [ip, bits] = value.split("/");
        return { ip, prefix: Number(bits) };
      }
      return { ip: value, prefix: 32 };
    });
}

function isIpv4(ip: string): boolean {
  const parts = ip.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => {
      const n = Number(part);
      return Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === String(Number(part));
    })
  );
}

function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

export function ipAllowed(ip: string, allowlist: Cidr[]): boolean {
  if (!ip || !isIpv4(ip) || allowlist.length === 0) {
    return false;
  }
  const value = ipToInt(ip);
  return allowlist.some((cidr) => {
    const shift = 32 - cidr.prefix;
    if (shift === 32) {
      return true;
    }
    const mask = shift === 0 ? 0xffffffff : (~((1 << shift) - 1)) >>> 0;
    return (value & mask) === (ipToInt(cidr.ip) & mask);
  });
}

export function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}

function truncate(text: string): string {
  return text.length <= BODY_LIMIT ? text : `${text.slice(0, BODY_LIMIT)}…`;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(`${JSON.stringify(body)}\n`);
}

export function createProxy(config: { mcpUrl: string; allowlist: Cidr[] }) {
  const calls: StoredCall[] = [];

  function store(entry: StoredCall): void {
    calls.unshift(entry);
    if (calls.length > MAX_STORED_CALLS) {
      calls.length = MAX_STORED_CALLS;
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const ip = clientIp(req);

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok\n");
      return;
    }

    if (!ipAllowed(ip, config.allowlist)) {
      store({ at: new Date().toISOString(), ip, method: req.method ?? "GET", path: url.pathname, allowed: false });
      sendJson(res, 403, { error: "forbidden", ip });
      return;
    }

    if (req.method === "GET" && url.pathname === "/calls") {
      sendJson(res, 200, { calls });
      return;
    }

    const isMcpPath = url.pathname === "/" || url.pathname === "/mcp";
    if (req.method === "POST" && isMcpPath) {
      const body = await readBody(req);
      const target = `${config.mcpUrl}${url.pathname === "/" ? "/" : "/mcp"}`;
      const headers: Record<string, string> = {
        "content-type": req.headers["content-type"] ?? "application/json",
      };
      if (req.headers.accept) {
        headers.accept = req.headers.accept;
      }
      if (typeof req.headers["mcp-session-id"] === "string") {
        headers["mcp-session-id"] = req.headers["mcp-session-id"];
      }

      let upstream: Response;
      try {
        upstream = await fetch(target, { method: "POST", headers, body });
      } catch (error) {
        store({
          at: new Date().toISOString(),
          ip,
          method: "POST",
          path: url.pathname,
          allowed: true,
          request: truncate(body.toString("utf8")),
          upstreamStatus: 502,
          response: truncate(String(error instanceof Error ? error.message : error)),
        });
        sendJson(res, 502, { error: "bad_gateway" });
        return;
      }

      const responseText = truncate(await upstream.text());
      store({
        at: new Date().toISOString(),
        ip,
        method: "POST",
        path: url.pathname,
        allowed: true,
        request: truncate(body.toString("utf8")),
        upstreamStatus: upstream.status,
        response: responseText,
      });

      const outHeaders: Record<string, string> = {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      };
      const sessionId = upstream.headers.get("mcp-session-id");
      if (sessionId) {
        outHeaders["mcp-session-id"] = sessionId;
      }
      res.writeHead(upstream.status, outHeaders);
      res.end(responseText.endsWith("\n") ? responseText : `${responseText}\n`);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });
}
