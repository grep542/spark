/**
 * Index — client-side app
 * Connects to the Index wrapper server at /ws
 * which bridges to the OpenClaw Gateway at ws://127.0.0.1:18789
 */

// ─── State ────────────────────────────────────────────────
const state = {
  ws:          null,
  connected:   false,
  msgCount:    0,
  tokensIn:    0,
  tokensOut:   0,
  cost:        0,
  model:       'anthropic/claude-opus-4-6',
  session:     'main',
  channels:    [],
  inboxItems:  [],
  currentView: 'inbox',
}

// ─── OpenClaw Gateway API calls via /api proxy ─────────────
const api = {
  async get(path) {
    const r = await fetch('/api' + path)
    return r.json()
  },
  async post(path, body) {
    const r = await fetch('/api' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    return r.json()
  }
}

// ─── WebSocket to Gateway (via wrapper bridge) ─────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws`)
  state.ws = ws

  ws.onopen = () => {
    log('WebSocket bridge open', 'status')
    // Send a gateway identify/ping
    wsSend({ type: 'ping' })
  }

  ws.onmessage = (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }
    handleGatewayMessage(msg)
  }

  ws.onclose = () => {
    state.connected = false
    setStatus('connecting', 'Gateway disconnected — retrying…')
    log('Gateway disconnected', 'error')
    setTimeout(connectWS, 4000)
  }

  ws.onerror = () => {
    log('WebSocket error', 'error')
  }
}

function wsSend(obj) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj))
  }
}

// ─── Handle messages from Gateway ─────────────────────────
function handleGatewayMessage(msg) {
  // Status frames injected by our wrapper server
  if (msg.type === '__index_status') {
    if (msg.state === 'connected') {
      state.connected = true
      setStatus('connected', `Gateway live — ${msg.message}`)
      log('Gateway connected', 'status')
      // Bootstrap data
      loadSessions()
      loadChannels()
    } else if (msg.state === 'disconnected') {
      state.connected = false
      setStatus('connecting', msg.message)
    } else {
      setStatus('error', msg.message)
      log(msg.message, 'error')
    }
    return
  }

  log(`← ${msg.type || 'event'}`, 'event')

  // OpenClaw Gateway message types
  switch (msg.type) {
    case 'pong':
      break

    case 'message':
    case 'message.delta':
      handleIncomingMessage(msg)
      break

    case 'message.start':
      appendTypingIndicator()
      break

    case 'message.stop':
    case 'message.complete':
      removeTypingIndicator()
      if (msg.usage) updateUsage(msg.usage)
      break

    case 'session.update':
    case 'session.status':
      if (msg.session) updateSessionStats(msg.session)
      break

    case 'channel.status':
    case 'channels.update':
      if (msg.channels) {
        state.channels = msg.channels
        renderChannels()
        renderLiveChannels()
      }
      break

    case 'inbox.update':
    case 'message.inbound':
      if (msg.message) addInboxItem(msg.message)
      break

    default:
      // Catch all gateway events → log
      if (msg.event) log(`event:${msg.event}`, 'event')
  }
}

// ─── Gateway bootstrap ─────────────────────────────────────
async function loadSessions() {
  try {
    const data = await api.get('/sessions')
    if (data?.sessions?.length) {
      const main = data.sessions.find(s => s.id === 'main') || data.sessions[0]
      if (main) updateSessionStats(main)
    }
  } catch (e) {
    log('Could not load sessions (gateway may not expose REST)', 'error')
  }

  // Try to get status via WS command
  wsSend({ type: 'sessions.list' })
  wsSend({ type: 'session.status', session: state.session })
}

async function loadChannels() {
  try {
    const data = await api.get('/channels')
    if (data?.channels) {
      state.channels = data.channels
      renderChannels()
      renderLiveChannels()
      return
    }
  } catch (e) {}

  // Fallback: request via WS
  wsSend({ type: 'channels.list' })

  // Render static channel tiles with connect instructions
  renderStaticChannels()
  renderStaticLiveChannels()
}

// ─── Send a message to the agent ──────────────────────────
function sendChatMessage() {
  const input = document.getElementById('chatInput')
  const text  = input.value.trim()
  if (!text) return

  input.value = ''
  input.style.height = 'auto'

  appendUserMessage(text)
  state.msgCount++
  updateUsageDisplay()

  // Send to OpenClaw Gateway via WS
  wsSend({
    type:    'message',
    session: state.session,
    content: text,
    model:   state.model,
  })

  // Also try REST fallback
  if (!state.connected) {
    api.post('/agent', { message: text, session: state.session, model: state.model })
      .then(r => {
        if (r?.response || r?.content) {
          removeTypingIndicator()
          appendAssistantMessage(r.response || r.content)
        }
      })
      .catch(() => {
        removeTypingIndicator()
        appendSystemMsg('Gateway unreachable. Start with: openclaw gateway --port 18789')
      })
  }

  appendTypingIndicator()
  log(`→ message sent (${text.length} chars)`, 'event')
}

function sendCommand(cmd) {
  const input = document.getElementById('chatInput')
  input.value = cmd
  sendChatMessage()
}

// ─── Chat rendering ────────────────────────────────────────
function appendUserMessage(text) {
  const msgs = document.getElementById('messages')
  const div  = document.createElement('div')
  div.className = 'msg user'
  div.innerHTML = `
    <div class="msg-av">you</div>
    <div class="msg-body">
      <div class="msg-meta">You · ${now()}</div>
      <div class="msg-bubble">${esc(text)}</div>
    </div>`
  msgs.appendChild(div)
  msgs.scrollTop = msgs.scrollHeight
}

function appendAssistantMessage(text, thinking = null) {
  const msgs = document.getElementById('messages')
  removeTypingIndicator()
  const div = document.createElement('div')
  div.className = 'msg assistant'
  const thinkingHtml = thinking
    ? `<div class="msg-thinking">◈ thinking · ${thinking} tokens</div>`
    : ''
  div.innerHTML = `
    <div class="msg-av">ix</div>
    <div class="msg-body">
      ${thinkingHtml}
      <div class="msg-meta">Index · ${now()}</div>
      <div class="msg-bubble">${formatMessage(text)}</div>
    </div>`
  msgs.appendChild(div)
  msgs.scrollTop = msgs.scrollHeight
}

function appendTypingIndicator() {
  removeTypingIndicator()
  const msgs = document.getElementById('messages')
  const div  = document.createElement('div')
  div.id = 'typing'
  div.className = 'msg assistant'
  div.innerHTML = `
    <div class="msg-av">ix</div>
    <div class="msg-body">
      <div class="msg-bubble">
        <div class="typing-dots"><span></span><span></span><span></span></div>
      </div>
    </div>`
  msgs.appendChild(div)
  msgs.scrollTop = msgs.scrollHeight
}

function removeTypingIndicator() {
  document.getElementById('typing')?.remove()
}

function appendSystemMsg(text) {
  const msgs = document.getElementById('messages')
  const div  = document.createElement('div')
  div.className = 'msg-system'
  div.textContent = text
  msgs.appendChild(div)
  msgs.scrollTop = msgs.scrollHeight
}

function handleIncomingMessage(msg) {
  const text = msg.content || msg.delta || msg.text || ''
  if (!text) return
  removeTypingIndicator()

  // If streaming, accumulate into last assistant bubble
  const msgs   = document.getElementById('messages')
  const last   = msgs.querySelector('.msg.assistant:last-child .msg-bubble')
  const typing = msgs.querySelector('.typing-dots')
  if (last && !typing) {
    last.innerHTML = formatMessage((last.dataset.raw || '') + text)
    last.dataset.raw = (last.dataset.raw || '') + text
  } else {
    appendAssistantMessage(text, msg.thinking_tokens)
  }
  msgs.scrollTop = msgs.scrollHeight

  if (msg.usage) updateUsage(msg.usage)
}

// ─── Inbox ─────────────────────────────────────────────────
function addInboxItem(msg) {
  state.inboxItems.unshift({
    id:      msg.id || Date.now(),
    from:    msg.from || msg.sender || 'Unknown',
    channel: msg.channel || 'unknown',
    preview: msg.content || msg.text || '',
    time:    msg.ts ? new Date(msg.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : now(),
    unread:  true,
    tags:    [msg.channel || 'inbound']
  })
  renderInbox()
  updateInboxBadge()
}

function renderInbox() {
  const list   = document.getElementById('inboxList')
  const empty  = document.getElementById('inboxEmpty')
  const sub    = document.getElementById('inboxSub')
  const unread = state.inboxItems.filter(i => i.unread).length

  sub.textContent = `${state.inboxItems.length} messages · ${unread} unread`

  if (state.inboxItems.length === 0) {
    empty.style.display = 'flex'
    empty.querySelector('.ie-title').textContent =
      state.connected ? 'Inbox is empty' : 'Connecting to gateway…'
    return
  }

  empty.style.display = 'none'
  list.innerHTML = '<div class="inbox-date">Recent</div>'

  state.inboxItems.forEach(item => {
    const tile = document.createElement('div')
    tile.className = `inbox-item${item.unread ? ' unread' : ''}`
    tile.onclick = () => {
      item.unread = false
      tile.classList.remove('unread')
      tile.classList.add('selected')
      updateInboxBadge()
    }

    const [bg, fg, border] = channelColors(item.channel)
    tile.innerHTML = `
      <div class="ii-badge" style="background:${bg};border-color:${border};color:${fg}">
        ${channelMonogram(item.channel)}
      </div>
      <div class="ii-body">
        <div class="ii-top">
          <span class="ii-from">${esc(item.from)}</span>
          <span class="ii-channel">· ${esc(item.channel)}</span>
          <span class="ii-time">${item.time}</span>
        </div>
        <div class="ii-preview">${esc(item.preview)}</div>
        <div class="ii-tags">
          ${item.unread ? '<span class="ii-tag coral">Unread</span>' : ''}
          ${item.tags.map(t => `<span class="ii-tag">${esc(t)}</span>`).join('')}
        </div>
      </div>`
    list.appendChild(tile)
  })
}

function updateInboxBadge() {
  const unread = state.inboxItems.filter(i => i.unread).length
  const badge  = document.getElementById('badge-inbox')
  if (unread > 0) {
    badge.textContent  = unread
    badge.style.display = 'flex'
  } else {
    badge.style.display = 'none'
  }
}

function refreshInbox() {
  wsSend({ type: 'inbox.list', session: state.session })
  api.get('/sessions/' + state.session + '/history')
    .then(data => {
      if (data?.messages) {
        const inbound = data.messages.filter(m => m.role !== 'assistant').slice(-20)
        state.inboxItems = inbound.map(m => ({
          id:      m.id || Date.now(),
          from:    m.from || 'Client',
          channel: m.channel || 'webchat',
          preview: m.content || m.text || '',
          time:    now(),
          unread:  false,
          tags:    [m.channel || 'session']
        }))
        renderInbox()
      }
    })
    .catch(() => log('Could not load history', 'error'))
}

// ─── Channels ──────────────────────────────────────────────
const CHANNEL_DEFS = [
  { id:'whatsapp',  name:'WhatsApp',   type:'Messaging',    mono:'WA', bg:'green',  configKey:'channels.whatsapp.allowFrom' },
  { id:'slack',     name:'Slack',      type:'Team comms',   mono:'SL', bg:'amber',  configKey:'channels.slack.botToken' },
  { id:'telegram',  name:'Telegram',   type:'Messaging',    mono:'TG', bg:'blue',   configKey:'channels.telegram.botToken' },
  { id:'gmail',     name:'Gmail',      type:'Email',        mono:'GM', bg:'coral',  configKey:'channels.gmail' },
  { id:'discord',   name:'Discord',    type:'Community',    mono:'DC', bg:'purple', configKey:'channels.discord.token' },
  { id:'signal',    name:'Signal',     type:'Messaging',    mono:'SG', bg:'green',  configKey:'channels.signal' },
  { id:'imessage',  name:'iMessage',   type:'BlueBubbles',  mono:'iM', bg:'green',  configKey:'channels.bluebubbles.serverUrl' },
  { id:'teams',     name:'Teams',      type:'Microsoft',    mono:'MT', bg:'blue',   configKey:'channels.msteams' },
]

const CONFIG_SNIPPETS = {
  whatsapp:  `// ~/.openclaw/openclaw.json\n{\n  "channels": {\n    "whatsapp": {\n      "allowFrom": ["+1234567890"],\n      "groups": {}\n    }\n  }\n}`,
  slack:     `// ~/.openclaw/openclaw.json\n{\n  "channels": {\n    "slack": {\n      "botToken": "xoxb-your-token",\n      "appToken": "xapp-your-token"\n    }\n  }\n}`,
  telegram:  `// ~/.openclaw/openclaw.json\n{\n  "channels": {\n    "telegram": {\n      "botToken": "123456:ABCDEF"\n    }\n  }\n}`,
  gmail:     `// Requires Gmail Pub/Sub setup.\n// Run: openclaw onboard\n// Docs: openclaw.ai/docs/gmail`,
  discord:   `// ~/.openclaw/openclaw.json\n{\n  "channels": {\n    "discord": {\n      "token": "your-bot-token"\n    }\n  }\n}`,
  signal:    `// Requires signal-cli installed.\n// ~/.openclaw/openclaw.json\n{\n  "channels": {\n    "signal": {\n      "number": "+1234567890"\n    }\n  }\n}`,
  imessage:  `// Requires BlueBubbles running on macOS.\n// ~/.openclaw/openclaw.json\n{\n  "channels": {\n    "bluebubbles": {\n      "serverUrl": "http://your-mac:1234",\n      "password": "yourpassword",\n      "webhookPath": "/webhook/bb"\n    }\n  }\n}`,
  teams:     `// Requires Teams app + Bot Framework.\n// See: openclaw.ai/docs/channels/teams`,
}

function renderStaticChannels() {
  const grid = document.getElementById('channelsGrid')
  grid.innerHTML = ''
  CHANNEL_DEFS.forEach(ch => {
    const live = state.channels.find(c => c.id === ch.id || c.type === ch.id)?.status === 'live'
    const tile = document.createElement('div')
    tile.className = `channel-tile${live ? ' live' : ''}`
    tile.onclick = () => showSnippet(ch)
    const [bg, fg, border] = channelColorsForId(ch.id)
    tile.innerHTML = `
      <div class="ct-icon" style="background:${bg};border-color:${border};color:${fg}">${ch.mono}</div>
      <div class="ct-name">${ch.name}</div>
      <div class="ct-type">${ch.type}</div>
      <div class="ct-status ${live ? 'live' : 'off'}">${live ? 'Live' : 'Setup'}</div>`
    grid.appendChild(tile)
  })
}

function renderChannels() {
  renderStaticChannels()
  renderLiveChannels()
}

function renderStaticLiveChannels() {
  const panel = document.getElementById('liveChannels')
  panel.innerHTML = ''
  const sideList = document.getElementById('channelList')
  sideList.innerHTML = ''

  CHANNEL_DEFS.forEach(ch => {
    const live = state.channels.find(c =>
      (c.id === ch.id || c.type === ch.id) && c.status === 'live'
    )

    // Right panel
    const row = document.createElement('div')
    row.className = `lc-row${live ? ' on' : ''}`
    row.innerHTML = `
      <div class="lc-mono">${ch.mono}</div>
      <span class="lc-name">${ch.name}</span>
      <span class="lc-state">${live ? 'live' : '—'}</span>`
    panel.appendChild(row)

    // Sidebar
    if (live) {
      const item = document.createElement('div')
      item.className = 'sn-item'
      item.setAttribute('data-view', 'inbox')
      item.onclick = () => { switchView('inbox'); setNav(item) }
      item.innerHTML = `<span class="sni-icon" style="font-family:var(--f-mono);font-size:0.55rem;font-weight:600">${ch.mono}</span>${ch.name}`
      sideList.appendChild(item)
    }
  })

  if (!sideList.children.length) {
    sideList.innerHTML = '<div class="sn-placeholder">No channels live yet</div>'
  }
}

function renderLiveChannels() {
  renderStaticLiveChannels()
}

// ─── Session stats ─────────────────────────────────────────
function updateSessionStats(session) {
  const ctx   = session.contextPercent || session.context_percent || 0
  const tIn   = session.tokensIn || session.tokens_in || session.inputTokens || 0
  const tOut  = session.tokensOut || session.tokens_out || session.outputTokens || 0
  const cost  = session.cost || 0
  const model = session.model || state.model

  state.model    = model
  state.tokensIn  = tIn
  state.tokensOut = tOut
  state.cost      = cost

  document.getElementById('statCtx').textContent    = ctx ? `${Math.round(ctx)}%` : '—'
  document.getElementById('statTokens').textContent = tIn ? `${(tIn + tOut).toLocaleString()}` : '—'
  document.getElementById('statCost').textContent   = cost ? `$${cost.toFixed(4)}` : '—'
  document.getElementById('ctxFill').style.width    = `${Math.min(ctx, 100)}%`
  document.getElementById('suSession').textContent  = session.id || 'main session'

  const mdName = model.split('/').pop() || model
  document.getElementById('mdName').textContent = mdName
  document.getElementById('mdMeta').textContent = model
  document.getElementById('navModel').textContent = mdName

  updateUsageDisplay()
}

function updateUsage(usage) {
  if (usage.input_tokens)  state.tokensIn  += usage.input_tokens
  if (usage.output_tokens) state.tokensOut += usage.output_tokens
  updateUsageDisplay()
}

function updateUsageDisplay() {
  document.getElementById('uTokenIn').textContent  = state.tokensIn.toLocaleString()
  document.getElementById('uTokenOut').textContent = state.tokensOut.toLocaleString()
  document.getElementById('uCost').textContent     = `$${state.cost.toFixed(4)}`
  document.getElementById('uMsgs').textContent     = state.msgCount
}

// ─── Model switching ───────────────────────────────────────
function setModel(btn, modelId) {
  state.model = modelId
  document.querySelectorAll('.mq-btn').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
  const name = modelId.split('/').pop()
  document.getElementById('mdName').textContent = name
  document.getElementById('mdMeta').textContent = modelId
  document.getElementById('navModel').textContent = name
  wsSend({ type: 'session.patch', session: state.session, model: modelId })
  log(`Model set: ${modelId}`, 'event')
}

// ─── View navigation ───────────────────────────────────────
function switchView(id) {
  state.currentView = id
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'))
  document.getElementById('view-' + id)?.classList.add('active')
  document.querySelectorAll('.nav-link').forEach(a => {
    a.classList.toggle('active', a.dataset.view === id)
  })
  document.querySelectorAll('.sn-item[data-view]').forEach(a => {
    a.classList.toggle('active', a.dataset.view === id)
  })
}

function setNav(el) {
  document.querySelectorAll('.sn-item').forEach(i => i.classList.remove('active'))
  el.classList.add('active')
}

// ─── Doctor ────────────────────────────────────────────────
async function runDoctor() {
  appendSystemMsg('Running openclaw doctor…')
  switchView('chat')
  try {
    const data = await api.post('/doctor', {})
    appendAssistantMessage(data?.output || JSON.stringify(data, null, 2))
  } catch {
    appendSystemMsg('Doctor endpoint not available. Run: openclaw doctor in terminal')
  }
}

// ─── Command palette ───────────────────────────────────────
const COMMANDS = [
  { cmd: '/status',       desc: 'Show session status, model, tokens, cost' },
  { cmd: '/new',          desc: 'Reset the session' },
  { cmd: '/compact',      desc: 'Compact session context (summarise)' },
  { cmd: '/think high',   desc: 'Set thinking level to high' },
  { cmd: '/think off',    desc: 'Disable thinking' },
  { cmd: '/verbose on',   desc: 'Enable verbose output' },
  { cmd: '/usage full',   desc: 'Show full usage footer on each response' },
  { cmd: '/activation always', desc: 'Activate in groups without mention' },
  { cmd: '/restart',      desc: 'Restart the gateway (owner only)' },
]
let cpFocused = 0

function insertSlash() {
  openCmdPalette()
}

function openCmdPalette() {
  document.getElementById('cmdBg').classList.add('open')
  document.getElementById('cpInput').value = ''
  renderCmdList(COMMANDS)
  setTimeout(() => document.getElementById('cpInput').focus(), 50)
}

function closeCmdPalette() {
  document.getElementById('cmdBg').classList.remove('open')
}

function filterCommands(val) {
  const q = val.toLowerCase()
  const filtered = COMMANDS.filter(c =>
    c.cmd.includes(q) || c.desc.toLowerCase().includes(q)
  )
  renderCmdList(filtered)
}

function renderCmdList(cmds) {
  const list = document.getElementById('cpList')
  list.innerHTML = ''
  cpFocused = 0
  cmds.forEach((c, i) => {
    const div = document.createElement('div')
    div.className = `cp-item${i === 0 ? ' focused' : ''}`
    div.innerHTML = `<span class="cp-cmd">${esc(c.cmd)}</span><span class="cp-desc">${esc(c.desc)}</span>`
    div.onclick = () => { execCommand(c.cmd); closeCmdPalette() }
    list.appendChild(div)
  })
}

function cpKey(e) {
  const items = document.querySelectorAll('.cp-item')
  if (e.key === 'ArrowDown') {
    cpFocused = Math.min(cpFocused + 1, items.length - 1)
  } else if (e.key === 'ArrowUp') {
    cpFocused = Math.max(cpFocused - 1, 0)
  } else if (e.key === 'Enter') {
    items[cpFocused]?.click()
    return
  } else if (e.key === 'Escape') {
    closeCmdPalette()
    return
  }
  items.forEach((el, i) => el.classList.toggle('focused', i === cpFocused))
}

function execCommand(cmd) {
  const input = document.getElementById('chatInput')
  input.value = cmd
  switchView('chat')
  sendChatMessage()
}

// ─── Snippet modal ─────────────────────────────────────────
function showSnippet(ch) {
  document.getElementById('snippetTitle').textContent = `Connect ${ch.name}`
  document.getElementById('snippetSub').textContent =
    `Add this to ~/.openclaw/openclaw.json, then restart your gateway.`
  document.getElementById('snippetCode').textContent =
    CONFIG_SNIPPETS[ch.id] || `// See openclaw.ai/docs/channels/${ch.id}`
  document.getElementById('snippetBg').classList.add('open')
}

function closeSnippet() {
  document.getElementById('snippetBg').classList.remove('open')
}

function copySnippet() {
  const code = document.getElementById('snippetCode').textContent
  navigator.clipboard.writeText(code).then(() => {
    const btn = document.querySelector('.btn-primary-sm')
    btn.textContent = 'Copied!'
    setTimeout(() => btn.textContent = 'Copy config', 1500)
  })
}

function openCronModal() {
  const expr = prompt('Cron expression (e.g. "0 7 * * *") and task:')
  if (!expr) return
  wsSend({ type: 'cron.create', schedule: expr, session: state.session })
  appendSystemMsg(`Cron created: ${expr}`)
  switchView('chat')
}

// ─── Status bar ────────────────────────────────────────────
function setStatus(state, message) {
  const bar  = document.getElementById('statusBar')
  const text = document.getElementById('statusText')
  const pill = document.getElementById('navPill')
  const pillText = document.getElementById('navPillText')

  bar.className = 'status-bar status-' + state
  text.textContent = message

  pill.className = 'nav-status-pill' + (state === 'connected' ? ' live' : '')
  pillText.textContent = state === 'connected' ? 'live' : state
}

// ─── Gateway log ───────────────────────────────────────────
function log(msg, type = '') {
  const logEl = document.getElementById('gatewayLog')
  const line  = document.createElement('div')
  line.className = `log-line ${type}`
  line.textContent = `${now(true)} ${msg}`
  logEl.appendChild(line)
  logEl.scrollTop = logEl.scrollHeight
  // keep last 80 lines
  while (logEl.children.length > 80) logEl.removeChild(logEl.firstChild)
}

function clearLog() {
  document.getElementById('gatewayLog').innerHTML = ''
}

// ─── Helpers ───────────────────────────────────────────────
function now(full = false) {
  const d = new Date()
  if (full) return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})
  return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
}

function formatMessage(text) {
  // Very light markdown: code blocks, inline code, bold
  return esc(text)
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>')
}

function autoGrow(el) {
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 140) + 'px'
}

function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage() }
  if (e.key === 'Escape') closeCmdPalette()
  if (e.key === '/' && e.target.value === '') { e.preventDefault(); openCmdPalette() }
}

function channelMonogram(ch) {
  const map = {
    whatsapp:'WA', slack:'SL', telegram:'TG', discord:'DC',
    gmail:'GM', signal:'SG', imessage:'iM', teams:'MT',
    webchat:'WC', matrix:'MX', zalo:'ZL'
  }
  return map[ch?.toLowerCase()] || (ch || 'XX').substring(0,2).toUpperCase()
}

function channelColors(ch) {
  return channelColorsForId(ch?.toLowerCase() || '')
}

function channelColorsForId(id) {
  const map = {
    whatsapp: ['#edf7f2','#2d7a5a','#a8dac4'],
    slack:    ['#fdf4e3','#c97c1a','#f0d89a'],
    telegram: ['#eef3fc','#2558b8','#b0c4ed'],
    discord:  ['#f0f0ff','#5865f2','#c0c8ff'],
    gmail:    ['#fdf1ee','#e05c3a','#f0cec6'],
    signal:   ['#edf7f2','#2d7a5a','#a8dac4'],
    imessage: ['#edf7f2','#2d7a5a','#a8dac4'],
    teams:    ['#eef3fc','#2558b8','#b0c4ed'],
    webchat:  ['#f3f0eb','#6b6156','#ddd8d0'],
  }
  return map[id] || ['#f3f0eb','#6b6156','#ddd8d0']
}

// ─── Nav event binding ─────────────────────────────────────
document.querySelectorAll('.nav-link').forEach(a => {
  a.addEventListener('click', () => {
    const v = a.dataset.view
    if (v) switchView(v)
  })
})

document.querySelectorAll('.sn-item[data-view]').forEach(a => {
  a.addEventListener('click', () => {
    const v = a.dataset.view
    if (v) { switchView(v); setNav(a) }
  })
})

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeCmdPalette()
    closeSnippet()
  }
  // ⌘K / Ctrl+K opens command palette
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault()
    openCmdPalette()
  }
})

// ─── Init ─────────────────────────────────────────────────
renderStaticChannels()
renderStaticLiveChannels()
connectWS()
