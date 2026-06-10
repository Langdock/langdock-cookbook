import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express, { Request, Response, NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

// Store transports by session ID
const streamableTransports: Record<string, StreamableHTTPServerTransport> = {};
// Store current request headers for the active request
let currentRequestHeaders: Record<string, string | string[] | undefined> = {};

// Create MCP server instance
const server = new McpServer(
  {
    name: "langdock-file-upload-mcp-server",
    title: "Langdock file upload MCP Server",
    version: "1.0.0",
    websiteUrl: "https://www.langdock.com",
    icons: [
      {
        src: "https://avatars.githubusercontent.com/u/136317085?s=200&v=4",
        mimeType: "image/png",
      },
    ],
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

server.registerTool(
  "inspect-file-input",
  {
    title: "Inspect File Input",
    description: "Accept a file and return basic file metadata",
    inputSchema: {
      file: z
        .object({
          fileName: z.string(),
          mimeType: z.string(),
          base64: z.string(),
          size: z.number().optional(),
        })
        .describe("File to inspect")
        .meta({ format: "file" }),
    },
  },
  async ({ file }) => {
    const buffer = Buffer.from(file.base64, "base64");

    const uploadsDir = join(process.cwd(), "uploads");
    const savedPath = join(uploadsDir, file.fileName);
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(savedPath, buffer);
    console.log(`💾 Saved file to ${savedPath}`);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              filename: file.fileName,
              mimeType: file.mimeType,
              sizeBytes: buffer.length,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

async function runHttpServer(port: number = 3333) {
  const app = express();
  app.use(express.json());

  // Enable CORS with proper headers for MCP
  app.use((req: any, res: any, next: any) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, mcp-session-id"
    );
    res.header("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }
    next();
  });

  // Handle POST requests for client-to-server communication (StreamableHTTP)
  app.post("/mcp", async (req: any, res: any) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      // Store all request headers for use in tool handlers
      currentRequestHeaders = req.headers;

      let transport: StreamableHTTPServerTransport;

      if (sessionId && streamableTransports[sessionId]) {
        transport = streamableTransports[sessionId];
        console.log(`🔄 Reusing existing session ${sessionId}`);
      } else {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: async (newSessionId: string) => {
            streamableTransports[newSessionId] = transport;
            console.log(`✅ Session ${newSessionId} initialized`);
          },
          // DNS rebinding protection is disabled by default for backwards compatibility
          enableDnsRebindingProtection: true,
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            delete streamableTransports[transport.sessionId];
            console.log(`🧹 Cleaned up session ${transport.sessionId}`);
          }
        };

        await server.connect(transport);
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("❌ MCP request error:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.listen(port, () => {
    console.log(`MCP server running on http://localhost:${port}`);
  });
}

// Start the server
runHttpServer().catch(console.error);
