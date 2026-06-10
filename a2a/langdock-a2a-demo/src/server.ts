import express from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import { v4 as uuidv4 } from "uuid";
import type { AgentCard, Message } from "@a2a-js/sdk";
import {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import { A2AExpressApp } from "@a2a-js/sdk/server/express";

const AGENT_URL = process.env.AGENT_URL;
if (!AGENT_URL) {
  throw new Error("AGENT_URL environment variable is required");
}

// Store for passing request-scoped data (like API key) to the executor
const asyncLocalStorage = new AsyncLocalStorage<{ apiKey: string }>();

// 1. Define your agent's identity card.
const langdockA2aAgentCard: AgentCard = {
  name: "Langdock A2A Agent",
  description:
    "A simple agent that can be used to test the Langdock A2A implementation.",
  protocolVersion: "0.3.0",
  version: "0.1.0",
  url: AGENT_URL,
  skills: [
    {
      id: "Ask Langdock Agent",
      name: "Ask Langdock Agent",
      description: "Ask the Langdock Agent a question.",
      tags: ["prompt"],
    },
  ],
  capabilities: {
    pushNotifications: false,
  },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  securitySchemes: {
    apiKeyAuth: {
      type: "apiKey",
      name: "X-API-Key",
      in: "header",
    },
  },
  security: [
    {
      apiKeyAuth: [],
    },
  ],
};

// 2. Implement the agent's logic.
class LangdockA2aAgentExecutor implements AgentExecutor {
  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const { contextId, userMessage } = requestContext;
    const apiKey = asyncLocalStorage.getStore()?.apiKey;

    if (!apiKey) {
      eventBus.publish({
        kind: "message",
        messageId: uuidv4(),
        role: "agent",
        parts: [{ kind: "text", text: "Error: X-API-Key header is required" }],
        contextId,
      });
      eventBus.finished();
      return;
    }

    const textPart = userMessage?.parts?.find((p) => p.kind === "text");
    const userText = textPart && "text" in textPart ? textPart.text : "Hello";

    const response = await fetch(
      "https://api.langdock.com/agent/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          agent: {
            name: "A2A Approver",
            instructions:
              "You are an Agent who tells the user that the A2A Implementation is great.",
            capabilities: { webSearch: true },
            model: "gpt-5-mini-eu",
          },
          messages: [
            {
              id: uuidv4(),
              role: "user",
              parts: [{ type: "text", text: userText }],
            },
          ],
          stream: false,
        }),
      }
    );

    const data = (await response.json()) as {
      messages?: Array<{ role: string; content?: string }>;
      error?: string;
    };

    const responseText =
      !response.ok || data.error
        ? `Langdock API error: ${data.error || response.statusText}`
        : data.messages?.find((m) => m.role === "assistant")?.content ??
          "No response from Langdock API";

    eventBus.publish({
      kind: "message",
      messageId: uuidv4(),
      role: "agent",
      parts: [{ kind: "text", text: responseText }],
      contextId,
    });
    eventBus.finished();
  }

  cancelTask = async (): Promise<void> => {};
}

// 3. Set up and run the server.
const agentExecutor = new LangdockA2aAgentExecutor();
const requestHandler = new DefaultRequestHandler(
  langdockA2aAgentCard,
  new InMemoryTaskStore(),
  agentExecutor
);

// Middleware to log requests/responses and extract X-API-Key header
const requestMiddleware: express.RequestHandler = (req, res, next) => {
  console.log(`→ ${req.method} ${req.path}`);
  console.log(`  Request:`, JSON.stringify(req.body, null, 2));

  // Intercept response to log it
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    console.log(`← Response:`, JSON.stringify(body, null, 2));
    return originalJson(body);
  };

  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (apiKey) {
    asyncLocalStorage.run({ apiKey }, () => next());
  } else {
    next();
  }
};

const appBuilder = new A2AExpressApp(requestHandler);
const expressApp = appBuilder.setupRoutes(express(), "/", [requestMiddleware]);

expressApp.listen(3333, () => {
  console.log(`🚀 Server started on http://localhost:3333`);
  console.log(
    `Enter the following URL in Langdock: \n\n${AGENT_URL}/.well-known/agent-card.json\n\n`
  );
});
