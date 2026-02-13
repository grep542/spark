/**
 * Index Wrapper Server
 * Sits in front of the OpenClaw Gateway at ws://127.0.0.1:18789
 * Serves the Index UI and proxies all Gateway API calls + WebSocket
 */

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const GATEWAY_HOST = process.env.GATEWAY_HOST || '127.0.0.1'
const GATEWAY_PORT = process.env.GATEWAY_PORT || 18789
const GATEWAY_WS   = `ws://${GATEWAY_HOST}:${GATEWAY_PORT}`
const GATEWAY_HTTP = `http://${GATEWAY_HOST}:${GATEWAY_PORT}`
const PORT         = process.env.PORT || 3000

const app = express()
app.use(express.json())
app.use(express.static(join(ROOT, 'public')))

// ── Health ──────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, gateway: GATEWAY_HTTP }))

// ── Proxy all /api/* calls to the OpenClaw Gateway ──────
// OpenClaw exposes REST endpoints under its root.
// We forward everything under /api/ to the gateway directly.
app.all('/api/*', async (req, res) => {
  const path = req.url.replace(/^\/api/, '')
  const url  = `${GATEWAY_HTTP}${path}`

  try {
    const upstream = await fetch(url, {
      method:  req.method,
      headers: {
        'content-type': 'application/json',
        ...(req.headers.authorization
          ? { authorization: req.headers.authorization }
          : {})
      },
      body: ['POST','PUT','PATCH'].includes(req.method)
        ? JSON.stringify(req.body)
        : undefined
    })

    const ct = upstream.headers.get('content-type') || ''
    res.status(upstream.status)

    if (ct.includes('application/json')) {
      const data = await upstream.json()
      res.json(data)
    } else {
      const text = await upstream.text()
      res.type('text').send(text)
    }
  } catch (err) {
    res.status(502).json({
      error:   'gateway_unreachable',
      message: `Cannot reach OpenClaw Gateway at ${GATEWAY_HTTP}`,
      hint:    'Run: openclaw gateway --port 18789'
    })
  }
})

// ── Catch-all → serve index.html (SPA) ──────────────────
app.get('*', (_req, res) => {
  res.sendFile(join(ROOT, 'public', 'index.html'))
})

// ── HTTP + WebSocket server ──────────────────────────────
const server = createServer(app)
const wss    = new WebSocketServer({ server, path: '/ws' })

/**
 * WebSocket bridge:
 * Browser  <──/ws──>  Index Wrapper  <──18789──>  OpenClaw Gateway
 *
 * The wrapper acts as a transparent proxy with one addition:
 * it injects connection status frames so the UI knows when
 * the gateway is up or down without needing extra polling.
 */
wss.on('connection', (clientSocket, req) => {
  console.log('[index] browser connected')

  let gatewaySocket = null
  let buffer        = []   // messages queued before gateway connects
  let alive         = true

  const connectGateway = () => {
    try {
      gatewaySocket = new WebSocket(GATEWAY_WS, {
        handshakeTimeout: 5000
      })
    } catch (e) {
      sendStatus('error', `Cannot create socket: ${e.message}`)
      return
    }

    gatewaySocket.on('open', () => {
      console.log('[index] gateway connected')
      sendStatus('connected', `Gateway live at ${GATEWAY_WS}`)
      // flush buffered messages
      buffer.forEach(msg => {
        if (gatewaySocket.readyState === WebSocket.OPEN)
          gatewaySocket.send(msg)
      })
      buffer = []
    })

    gatewaySocket.on('message', (data) => {
      if (clientSocket.readyState === WebSocket.OPEN)
        clientSocket.send(data)
    })

    gatewaySocket.on('close', (code, reason) => {
      console.log('[index] gateway disconnected', code)
      sendStatus('disconnected', 'Gateway closed — retrying in 3s')
      if (alive) setTimeout(connectGateway, 3000)
    })

    gatewaySocket.on('error', (err) => {
      console.error('[index] gateway error', err.message)
      sendStatus('error', err.message)
    })
  }

  const sendStatus = (state, message) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(JSON.stringify({
        type: '__index_status',
        state,   // 'connected' | 'disconnected' | 'error'
        message,
        ts: Date.now()
      }))
    }
  }

  // Forward browser → gateway
  clientSocket.on('message', (data) => {
    if (gatewaySocket?.readyState === WebSocket.OPEN) {
      gatewaySocket.send(data)
    } else {
      buffer.push(data)
    }
  })

  clientSocket.on('close', () => {
    console.log('[index] browser disconnected')
    alive = false
    gatewaySocket?.close()
  })

  connectGateway()
})

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║  Index  —  running on :${PORT}           ║
║  Wrapping OpenClaw @ ${GATEWAY_WS}  ║
╚══════════════════════════════════════╝

  Open  →  http://localhost:${PORT}
  Docs  →  https://openclaw.ai/docs
`)
})
