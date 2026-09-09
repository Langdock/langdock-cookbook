# Agent API embed widget

Put a Langdock agent on your own site as an iframe or chat bubble. The browser
never sees the API key. Users can type, paste screenshots, or attach files.

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/)
- A Langdock workspace API key with `ASSISTANT_API` and `KNOWLEDGE_FOLDER_API`
- An agent shared with that key

## Setup & run

```bash
cp .env.example .env
```

Fill in `LANGDOCK_API_KEY` and `LANGDOCK_AGENT_ID`. Dedicated deployments also
need `LANGDOCK_API_BASE` (for example `https://langdock.yourcompany.com/api/public`).

```bash
pnpm d
```

Open `http://127.0.0.1:3333/demo.html` for the bubble, or
`http://127.0.0.1:3333/` for the iframe panel.

## Embed

```html
<iframe src="https://YOUR_HOST/" width="400" height="600" style="border:none"></iframe>
```

```html
<script src="https://YOUR_HOST/widget.js"></script>
```

## How it works

The widget is a thin proxy in front of two Agent API endpoints.

1. **Chat** — `POST /chat` forwards Vercel AI SDK `UIMessage`s to
   `/agent/v1/chat/completions` and streams the reply back.
2. **Attachments** — paste, drop, or the paperclip uploads the file through
   `POST /upload` to `/attachment/v1/upload`. The returned UUID goes on the
   user message as `metadata.attachments`. Do not send uploaded files as
   `type: "file"` parts; that format is for inline data URIs.

Max upload size is 20MB. The key stays on the server.
