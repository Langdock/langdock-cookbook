# Langdock MCP File Upload Demo

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

This project is a small MCP server built with Express and the official MCP SDK. It demonstrates how Langdock resolves file references into structured `FileData` objects before passing them to an MCP tool. The server exposes a single tool, `inspect-file-input`, that accepts a file and returns basic metadata about it.

## How It Works

### What Langdock does

When an MCP tool has a field with `format: "file"` in its JSON schema, Langdock's engine intercepts the LLM's file reference (a filename string like `a0vs09.jpg`, a storage path like `attachment/<uuid>/<filename>`, or `/mnt/data/<filename>`) and resolves it into a `FileData` object before the MCP server ever receives the call.

### FileData shape

```typescript
{
  fileName: string;       // original filename, e.g. "report.pdf"
  mimeType: string;       // e.g. "image/jpeg", "application/pdf"
  base64: string;         // full file content, base64-encoded
  size: number;           // byte length
  lastModified: Date;
}
```

### What the MCP server must do

Declare the input field as a Zod object matching that shape — **not** `z.string()`. The MCP SDK validates inputs before calling the handler, so the schema must match what it actually receives:

```typescript
server.registerTool(
  "inspect-file-input",
  {
    inputSchema: {
      file: z
        .object({
          fileName: z.string(),
          mimeType: z.string(),
          base64: z.string(),
          size: z.number().optional(),
        })
        .describe("File to inspect")
        .meta({ format: "file" }), // ← tells Langdock to resolve the reference
    },
  },
  async ({ file }) => {
    const buffer = Buffer.from(file.base64, "base64");
    // use buffer, file.fileName, file.mimeType, etc.
  },
);
```

### The `.meta({ format: "file" })` marker

This is the signal to Langdock. When saving the MCP integration, `mapJsonTypeToActionFieldType` detects `format: "file"` in the JSON schema and stores the field as `ActionFieldInputType.FILE` in the database. At execution time, `resolveFileInputs` finds all `FILE` fields, resolves the string reference the LLM provided into a full `FileData` object, and passes that to the MCP server instead.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/) 10+

Install `pnpm` globally if needed:

```bash
npm install -g pnpm
```

### Run the Server / Install Dependencies

```bash
pnpm d
```

The MCP endpoint will be available at:

```text
http://localhost:3333/mcp
```

If you are testing in Langdock and need HTTPS, expose the local server with a tunnel:

```bash
ngrok http 3333
```

Then use your public MCP endpoint, for example:

```text
https://your-ngrok-url.ngrok-free.app/mcp
```

## Example Tool Input

```json
{
  "file": {
    "fileName": "example.txt",
    "mimeType": "text/plain",
    "base64": "SGVsbG8gd29ybGQ=",
    "size": 11
  }
}
```

## Example Tool Output

```json
{
  "success": true,
  "filename": "example.txt",
  "mimeType": "text/plain",
  "sizeBytes": 11
}
```

## Notes

- CORS is enabled for local testing.
- The server supports MCP session reuse via the `mcp-session-id` header.
- DNS rebinding protection is enabled on the transport.
