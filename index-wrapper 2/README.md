# Index

A clean production UI wrapper around [OpenClaw](https://openclaw.ai) — the self-hosted personal AI gateway.

Index sits in front of your running OpenClaw Gateway and gives you a unified inbox, chat interface, channel manager, and automation runner — all in one focused dashboard built for solopreneurs.

---

## How it works

```
Browser ──/ws──► Index Wrapper :3000 ──ws://──► OpenClaw Gateway :18789
                 (Express + WS bridge)           (openclaw gateway)
```

Index is a thin server that:
1. Serves the UI from `public/`
2. Proxies all `/api/*` HTTP calls to the OpenClaw Gateway REST endpoints
3. Bridges the browser WebSocket to the Gateway WebSocket — with connection status frames injected so the UI always knows if the gateway is up

---

## Requirements

- Node.js ≥ 18
- OpenClaw installed and a gateway running: `openclaw gateway --port 18789`

---

## Setup

### 1. Install OpenClaw (if not already)

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

### 2. Start your Gateway

```bash
openclaw gateway --port 18789 --verbose
```

### 3. Install and run Index

```bash
cd index-wrapper
npm install
npm start
```

Open **http://localhost:3000**

---

## Configuration

| Env var        | Default         | Description                    |
|----------------|-----------------|--------------------------------|
| `GATEWAY_HOST` | `127.0.0.1`     | OpenClaw gateway host          |
| `GATEWAY_PORT` | `18789`         | OpenClaw gateway port          |
| `PORT`         | `3000`          | Index wrapper port             |

```bash
# Custom gateway location
GATEWAY_HOST=192.168.1.10 GATEWAY_PORT=18789 npm start
```

---

## Features

### Unified Inbox
All inbound messages from every connected channel (WhatsApp, Slack, Gmail, Telegram, Discord, Signal, iMessage) stream in real time via the Gateway WebSocket.

### Chat
Direct chat with your Index AI (backed by OpenClaw's agent). Supports all OpenClaw slash commands:

| Command | Effect |
|---|---|
| `/status` | Show tokens, cost, model |
| `/new` | Reset session |
| `/compact` | Summarise and compact context |
| `/think high` | Enable extended thinking |
| `/verbose on` | Verbose responses |
| `/usage full` | Full usage footer |

Press `/` or `⌘K` to open the command palette.

### Channels
See all channel statuses live. Click any channel tile to get the exact `openclaw.json` config snippet to paste and activate it.

### Automations
View and toggle cron-based automations running in OpenClaw. Create new ones inline.

---

## Connect a channel

Click any channel in the **Channels** view to get a config snippet. Paste it into `~/.openclaw/openclaw.json` and restart the gateway.

Or run guided setup:

```bash
openclaw onboard
```

---

## Production deployment

For a VPS/server deployment:

```bash
# On your server
npm install -g openclaw@latest pm2

# Start gateway as a daemon
openclaw gateway --port 18789
# or: openclaw onboard --install-daemon  (installs as systemd service)

# Start Index wrapper
cd index-wrapper
npm install
pm2 start npm --name index -- start
pm2 save

# Expose via nginx (optional)
# proxy_pass http://127.0.0.1:3000;
```

For HTTPS + auth, put nginx or Caddy in front with a basic auth layer. The Gateway itself is loopback-only by default.

---

## File structure

```
index-wrapper/
├── src/
│   └── server.js       ← Express + WS bridge
├── public/
│   ├── index.html      ← App shell
│   ├── css/app.css     ← All styles
│   └── js/app.js       ← All client logic
├── package.json
└── README.md
```

---

Built on [OpenClaw](https://github.com/openclaw/openclaw) — MIT License.
