// Render a sample diagram through the real render_diagram tool and write the
// resulting UI HTML to a file you can open in a browser to see the editable
// draw.io canvas. Run with: node scripts/preview.mjs
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/server.js";

const server = createMcpServer();
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "preview", version: "1.0.0" });
await Promise.all([server.connect(serverT), client.connect(clientT)]);

// Step 1: build the XML (what the model does first).
const created = await client.callTool({
  name: "create_diagram",
  arguments: {
    nodes: [
      { id: "start", label: "Commit pushed", shape: "terminator", fillColor: "#d5e8d4", strokeColor: "#82b366" },
      { id: "ci", label: "Run CI", shape: "process" },
      { id: "pass", label: "Tests pass?", shape: "diamond" },
      { id: "deploy", label: "Deploy to prod", shape: "process", fillColor: "#ffe6cc", strokeColor: "#d79b00" },
      { id: "fix", label: "Fix & retry", shape: "process" },
      { id: "done", label: "Live", shape: "terminator", fillColor: "#d5e8d4", strokeColor: "#82b366" },
    ],
    edges: [
      { source: "start", target: "ci" },
      { source: "ci", target: "pass" },
      { source: "pass", target: "deploy", label: "yes" },
      { source: "pass", target: "fix", label: "no", dashed: true },
      { source: "fix", target: "ci" },
      { source: "deploy", target: "done" },
    ],
  },
});
const xml = created.content.find((c) => c.type === "text")?.text;

// Step 2: render the built XML (what the model does second).
const res = await client.callTool({
  name: "render_diagram",
  arguments: { title: "Deployment Flow", xml },
});

const html = res.content.find((c) => c.type === "resource")?.resource?.text;
if (!html) {
  console.error("No resource HTML returned");
  process.exit(1);
}
const out = "/tmp/drawio-preview.html";
writeFileSync(out, html);
console.log(out);

await client.close();
await server.close();
