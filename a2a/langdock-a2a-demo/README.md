# Demo Langdock A2A Agent

This repo is a sample of a simple implementation of an A2A agent compatible with Langdock's implementation of the A2A protocol.

## Requirements

The following is needed to run / experiment with this repo:

1. Langdock Account & API key with access to the Agent API

2. [Node.js](https://nodejs.org/) (v18 or higher recommended)

```bash
brew install node
```

3. [pnpm](https://pnpm.io/) package manager

```bash
brew install pnpm
```

4. [ngrok](https://ngrok.com/) for tunneling

```bash
brew install ngrok
```

## Getting Started

1. Tunnel the server port with ngrok

```bash
ngrok http 3333
```

2. Install dependencies and run dev server with your ngrok URL

```bash
AGENT_URL=https://<your-ngrok-url>.ngrok-free.app pnpm d
```

3. Copy the Url from the Terminal output

4. Open Langdock and "add integration" -> "start from scratch" -> "Connect Remote Agent (A2A)" -> paste the copied url into the input field:

- Run this command (in a different terminal) to open the langdock integrations page:

```bash
pnpm langdock
```

5. Create a Connection to the Agent

Just use an langdock api-key with the `Agent API` Scope, it will be forwarded to the A2A

(Optionally) Open the A2A Inspector to test your agent:

```bash
pnpm inspector
```

## Agent Details

- **Protocol Version**: 0.3.0
- **Port**: 3333

## Dependencies

- `@a2a-js/sdk` - A2A protocol SDK
- `express` - Web framework
- `uuid` - UUID generation
