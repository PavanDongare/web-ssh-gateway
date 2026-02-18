// Custom server with WebSocket support for SSH connections
const { createServer } = require('http')
const { parse } = require('url')
const next = require('next')
const WebSocket = require('ws')
const ssh2 = require('ssh2')
const { Terminal: XTerminal } = require('@xterm/xterm')

// Suppress the deprecation warning
process.emitWarning = () => {}

const dev = process.env.NODE_ENV !== 'production'
const hostname = 'localhost'
const port = 3000

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

// Session persistence config
const SESSION_TIMEOUT_MS = 300000 // 5 minutes to reconnect

// Rolling output buffer per session — stores raw SSH bytes so we can replay
// them on reconnect, restoring the terminal to its exact visual state.
const MAX_OUTPUT_BUFFER = 200 * 1024 // 200 KB

// SSH connection sessions map (tabId -> session object)
const sessions = new Map()

// ---------------------------------------------------------------------------
// Binary frame protocol (Fix 6)
// Mirrors src/lib/ws-protocol.ts — keep in sync.
//
// Frame layout:
//   u8   type       — message type
//   u16  payloadLen — payload length LE
//   u8[] payload    — raw bytes
// ---------------------------------------------------------------------------
const MsgType = {
  // Client → Server
  AUTH:      0x01,
  RECONNECT: 0x02,
  DATA:      0x03,  // raw binary keystrokes
  RESIZE:    0x04,
  PING:      0x05,

  // Server → Client
  CONNECTED:    0x10,
  RECONNECTED:  0x11,
  REPLAY:       0x12,  // raw binary buffered output (fallback)
  SSH_DATA:     0x13,  // raw binary live output
  ERROR:        0x14,
  DISCONNECTED: 0x15,
  SNAPSHOT:     0x16,  // JSON: TerminalSnapshot — exact terminal state on reconnect
}

/** Encode a binary frame */
function encodeFrame(type, payload) {
  const buf = payload instanceof Buffer ? payload : Buffer.from(payload ?? [])
  const frame = Buffer.allocUnsafe(3 + buf.length)
  frame.writeUInt8(type, 0)
  frame.writeUInt16LE(buf.length, 1)
  buf.copy(frame, 3)
  return frame
}

/** Encode a frame with a JSON payload */
function encodeJsonFrame(type, data) {
  return encodeFrame(type, Buffer.from(JSON.stringify(data), 'utf8'))
}

/** Decode a binary frame. Returns null on error. */
function decodeFrame(raw) {
  const buf = raw instanceof Buffer ? raw : Buffer.from(raw)
  if (buf.length < 3) return null
  const type   = buf.readUInt8(0)
  const payLen = buf.readUInt16LE(1)
  if (buf.length < 3 + payLen) return null
  const payload = buf.slice(3, 3 + payLen)
  return { type, payload }
}

// ---------------------------------------------------------------------------
// Fix 7: Headless terminal snapshot helpers
// Attribute bit flags — mirror ws-protocol.ts ATTR_* constants
// ---------------------------------------------------------------------------
const ATTR_BOLD          = 0x01
const ATTR_ITALIC        = 0x02
const ATTR_UNDERLINE     = 0x04
const ATTR_DIM           = 0x08
const ATTR_INVERSE       = 0x10
const ATTR_INVISIBLE     = 0x20
const ATTR_STRIKETHROUGH = 0x40
const ATTR_BLINK         = 0x80

/**
 * Create a headless xterm Terminal instance for a session.
 * This tracks the exact visual state of the terminal (cursor, colors, TUI apps).
 */
function createHeadlessTerminal(cols, rows) {
  return new XTerminal({
    cols,
    rows,
    allowProposedApi: true,
    scrollback: 1000,
  })
}

/**
 * Serialize the headless terminal buffer into a TerminalSnapshot.
 * Only the visible rows (viewport) are included — same as VibeTunnel's approach.
 */
function serializeSnapshot(term) {
  const buf = term.buffer.active
  const cols = term.cols
  const rows = term.rows

  // Viewport: the last `rows` lines of the buffer
  const bufLen    = buf.length
  const startLine = Math.max(0, bufLen - rows)

  const lines = []
  const cellObj = {}  // reuse object for getCell

  for (let r = 0; r < rows; r++) {
    const lineIdx = startLine + r
    const line    = buf.getLine(lineIdx)
    const cells   = []

    if (!line) {
      // Empty line — push a single space cell
      cells.push({ ch: ' ', w: 1, fg: -1, bg: -1, at: 0 })
    } else {
      for (let c = 0; c < cols; c++) {
        const cell = line.getCell(c, cellObj)
        if (!cell) continue

        const w = cell.getWidth()
        if (w === 0) continue  // continuation cell for wide char

        let at = 0
        if (cell.isBold())          at |= ATTR_BOLD
        if (cell.isItalic())        at |= ATTR_ITALIC
        if (cell.isUnderline())     at |= ATTR_UNDERLINE
        if (cell.isDim())           at |= ATTR_DIM
        if (cell.isInverse())       at |= ATTR_INVERSE
        if (cell.isInvisible())     at |= ATTR_INVISIBLE
        if (cell.isStrikethrough()) at |= ATTR_STRIKETHROUGH
        if (cell.isBlink())         at |= ATTR_BLINK

        const fg = cell.getFgColor()
        const bg = cell.getBgColor()

        cells.push({
          ch: cell.getChars() || ' ',
          w,
          fg: (fg === undefined || fg === null) ? -1 : fg,
          bg: (bg === undefined || bg === null) ? -1 : bg,
          at,
        })
      }
    }

    lines.push(cells)
  }

  // Cursor position relative to viewport
  const cursorY = buf.cursorY
  const cursorX = buf.cursorX

  // viewportY: how far from the bottom (0 = at bottom, positive = scrolled up)
  const viewportY = Math.max(0, bufLen - rows - buf.viewportY)

  return {
    cols,
    rows,
    cursorX,
    cursorY,
    viewportY,
    lines,
  }
}

// ---------------------------------------------------------------------------
// Cleanup expired sessions every 30 seconds
// ---------------------------------------------------------------------------
setInterval(() => {
  const now = Date.now()
  for (const [tabId, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      console.log(`Session ${tabId} expired, closing SSH`)
      if (session.headlessTerm) { session.headlessTerm.dispose(); session.headlessTerm = null }
      if (session.stream) session.stream.close()
      if (session.conn) session.conn.end()
      sessions.delete(tabId)
    }
  }
}, 30000)

app.prepare().then(async () => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true)
      await handle(req, res, parsedUrl)
    } catch (err) {
      console.error('Error occurred handling', req.url, err)
      res.statusCode = 500
      res.end('internal server error')
    }
  })

  // perMessageDeflate: false — SSH data is already binary/uncompressable.
  // Disabling saves CPU on every frame without any bandwidth cost.
  const wss = new WebSocket.Server({ noServer: true, clientTracking: true, perMessageDeflate: false })

  // Next.js 13.1+ exposes getUpgradeHandler() so its HMR WebSocket works correctly
  const nextUpgradeHandler = await app.getUpgradeHandler()

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url)
    if (pathname === '/api/ssh') {
      wss.handleUpgrade(req, socket, head, (client) => {
        wss.emit('connection', client, req)
      })
    } else {
      nextUpgradeHandler(req, socket, head)
    }
  })

  // Heartbeat — ping every 30 seconds, terminate dead connections
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        console.log('Terminating dead WebSocket connection')
        return ws.terminate()
      }
      ws.isAlive = false
      ws.ping()
    })
  }, 30000)

  wss.on('close', () => clearInterval(heartbeatInterval))

  wss.on('connection', (ws) => {
    let tabId = null

    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })

    // Accept binary frames (Fix 6)
    ws.binaryType = 'nodebuffer'

    console.log('New WebSocket connection')

    ws.on('message', (raw) => {
      try {
        const frame = decodeFrame(raw)
        if (!frame) {
          console.warn('Received malformed frame, ignoring')
          return
        }

        switch (frame.type) {
          case MsgType.AUTH: {
            const msg = JSON.parse(frame.payload.toString('utf8'))
            tabId = msg.tabId
            console.log(`Creating new session for tab ${tabId} (${msg.username}@${msg.host})`)
            handleAuth(ws, msg, (session) => {
              sessions.set(tabId, session)
            })
            break
          }

          case MsgType.RECONNECT: {
            const msg = JSON.parse(frame.payload.toString('utf8'))
            tabId = msg.tabId
            const session = sessions.get(tabId)
            if (session && session.conn) {
              console.log(`Reconnecting to session ${tabId}`)
              attachToSession(ws, tabId, session)
            } else {
              ws.send(encodeJsonFrame(MsgType.ERROR, { message: 'Session expired. Please reconnect.' }))
            }
            break
          }

          case MsgType.DATA: {
            // Fix 6: raw binary keystrokes — no UTF-8 decode, no JSON parse
            // Fix 3: backpressure — pause WS if SSH write buffer is full
            const dataSession = sessions.get(tabId)
            if (dataSession?.stream && dataSession.stream.writable) {
              const canContinue = dataSession.stream.write(frame.payload)
              dataSession.lastActivity = Date.now()
              if (!canContinue) {
                ws.pause()
                dataSession.stream.once('drain', () => ws.resume())
              }
            }
            break
          }

          case MsgType.RESIZE: {
            const { cols, rows } = JSON.parse(frame.payload.toString('utf8'))
            const resizeSession = sessions.get(tabId)
            if (resizeSession?.stream) {
              resizeSession.stream.setWindow(rows, cols)
              resizeSession.lastActivity = Date.now()
              // Fix 7: resize the headless terminal to match
              if (resizeSession.headlessTerm) {
                resizeSession.headlessTerm.resize(cols, rows)
              }
            }
            break
          }

          case MsgType.PING: {
            const pingSession = sessions.get(tabId)
            if (pingSession) pingSession.lastActivity = Date.now()
            break
          }

          default:
            console.log('Unknown frame type:', frame.type)
        }
      } catch (err) {
        console.error('Error processing frame:', err)
      }
    })

    ws.on('close', () => {
      console.log(`WebSocket closed for ${tabId}`)
      const session = sessions.get(tabId)
      if (session) {
        session.ws = null
        session.lastActivity = Date.now()
        console.log(`Session ${tabId} kept alive for reconnection (${SESSION_TIMEOUT_MS}ms)`)
      }
    })

    ws.on('error', (err) => {
      console.error('WebSocket error:', err)
    })
  })

  server.listen(port, (err) => {
    if (err) throw err
    console.log(`> Ready on http://${hostname}:${port}`)
    console.log(`> WebSocket endpoint: ws://${hostname}:${port}/api/ssh`)
    console.log(`> Session persistence: ${SESSION_TIMEOUT_MS}ms`)
    console.log(`> Protocol: binary frames + headless terminal snapshot (Fix 6+7)`)
  })
})

/**
 * Attach a new WebSocket to an existing SSH session.
 *
 * Fix 7: If a headless terminal exists, send a SNAPSHOT frame so the client
 * can render the exact terminal state (cursor, colors, TUI apps like vim/htop).
 * Falls back to raw REPLAY if no headless terminal is available.
 */
function attachToSession(ws, tabId, session) {
  session.ws = ws
  session.lastActivity = Date.now()

  if (session.headlessTerm) {
    // Fix 7: serialize exact terminal state and send as SNAPSHOT
    try {
      const snapshot = serializeSnapshot(session.headlessTerm)
      ws.send(encodeJsonFrame(MsgType.SNAPSHOT, snapshot))
      console.log(`Sent terminal snapshot for session ${tabId} (${snapshot.cols}x${snapshot.rows}, ${snapshot.lines.length} lines)`)
    } catch (err) {
      console.error(`Failed to serialize snapshot for ${tabId}, falling back to replay:`, err)
      // Fallback: raw replay
      if (session.outputBuffer && session.outputBuffer.length > 0) {
        ws.send(encodeFrame(MsgType.REPLAY, session.outputBuffer))
      }
    }
  } else if (session.outputBuffer && session.outputBuffer.length > 0) {
    // Fallback: raw binary replay
    ws.send(encodeFrame(MsgType.REPLAY, session.outputBuffer))
  }

  ws.send(encodeFrame(MsgType.RECONNECTED))
  console.log(`Reattached WebSocket to session ${tabId}`)
}

/**
 * Handle SSH authentication and connection.
 */
function handleAuth(ws, msg, onReady) {
  const { host, port = 22, username, password, privateKey, passphrase, tabId } = msg

  if (!host || !username) {
    ws.send(encodeJsonFrame(MsgType.ERROR, { message: 'Host and username are required' }))
    return
  }

  if (!password && !privateKey) {
    ws.send(encodeJsonFrame(MsgType.ERROR, { message: 'Password or private key is required' }))
    return
  }

  const conn = new ssh2.Client()
  let session = null

  const config = {
    host,
    port: parseInt(port) || 22,
    username,
    readyTimeout: 20000,
    keepaliveInterval: 30000,
  }

  if (password) {
    config.password = password
  } else if (privateKey) {
    config.privateKey = privateKey
    if (passphrase) config.passphrase = passphrase
  }

  conn.on('ready', () => {
    console.log(`SSH connected to ${host}:${port}`)

    conn.shell(
      { term: 'xterm-256color', cols: 80, rows: 24 },
      (err, stream) => {
        if (err) {
          ws.send(encodeJsonFrame(MsgType.ERROR, { message: `Shell error: ${err.message}` }))
          conn.end()
          return
        }

        console.log('Shell opened')

        // Fix 7: create a headless terminal to track exact visual state
        const headlessTerm = createHeadlessTerminal(80, 24)

        // Pre-allocate a fixed-size ring buffer for output replay.
        // Avoids Buffer.concat on every chunk — just track write offset.
        const ringBuf    = Buffer.allocUnsafe(MAX_OUTPUT_BUFFER)
        let   ringOffset = 0
        let   ringFull   = false

        // Fix 6: outputBuffer is now a raw Buffer (binary-safe), not a string
        session = {
          conn,
          stream,
          ws,
          lastActivity: Date.now(),
          // Expose a getter so attachToSession can read the ring buffer
          get outputBuffer() {
            if (!ringFull && ringOffset === 0) return Buffer.alloc(0)
            if (!ringFull) return ringBuf.slice(0, ringOffset)
            // Ring wrapped: return [ringOffset..end] + [0..ringOffset]
            return Buffer.concat([ringBuf.slice(ringOffset), ringBuf.slice(0, ringOffset)])
          },
          headlessTerm,  // Fix 7: headless terminal for snapshot
        }

        const appendToBuffer = (chunk) => {
          // Write chunk into ring buffer — O(n) copy, no allocation
          let src = 0
          while (src < chunk.length) {
            const space = MAX_OUTPUT_BUFFER - ringOffset
            const toCopy = Math.min(space, chunk.length - src)
            chunk.copy(ringBuf, ringOffset, src, src + toCopy)
            src += toCopy
            ringOffset = (ringOffset + toCopy) % MAX_OUTPUT_BUFFER
            if (ringOffset === 0) ringFull = true
          }

          // Fix 7: feed raw bytes into the headless terminal so it tracks state
          if (session.headlessTerm) {
            session.headlessTerm.write(chunk)
          }
        }

        // Server-side output batching — leading-edge: send immediately on first
        // chunk (zero latency for echo), then coalesce subsequent chunks that
        // arrive in the same I/O tick via setImmediate (no timer overhead).
        let batchChunks  = []
        let batchPending = false

        const flushBatch = () => {
          batchPending = false
          if (batchChunks.length === 0) return
          const combined = batchChunks.length === 1 ? batchChunks[0] : Buffer.concat(batchChunks)
          batchChunks = []
          if (session.ws?.readyState === WebSocket.OPEN) {
            session.ws.send(encodeFrame(MsgType.SSH_DATA, combined))
          }
        }

        const enqueueChunk = (data) => {
          appendToBuffer(data)
          const isFirst = batchChunks.length === 0
          batchChunks.push(data)
          if (isFirst) {
            // Send immediately — zero latency for the first chunk (echo)
            flushBatch()
            // Schedule a setImmediate to catch any chunks arriving in the same tick
            if (!batchPending) {
              batchPending = true
              setImmediate(flushBatch)
            }
          } else if (!batchPending) {
            batchPending = true
            setImmediate(flushBatch)
          }
        }

        // Pipe SSH stdout → WebSocket (binary-safe) + headless terminal
        stream.on('data', (data) => {
          enqueueChunk(data)
        })

        stream.on('close', () => {
          console.log('Stream closed')
          batchPending = false
          batchChunks  = []
          if (session.headlessTerm) { session.headlessTerm.dispose(); session.headlessTerm = null }
          if (session.ws?.readyState === WebSocket.OPEN) {
            session.ws.send(encodeFrame(MsgType.DISCONNECTED))
          }
          sessions.delete(tabId)
          conn.end()
        })

        stream.stderr.on('data', (data) => {
          enqueueChunk(data)
        })

        ws.send(encodeFrame(MsgType.CONNECTED))
        onReady(session)
      }
    )
  })

  conn.on('error', (err) => {
    console.error('SSH connection error:', err)
    ws.send(encodeJsonFrame(MsgType.ERROR, { message: `SSH error: ${err.message}` }))
  })

  conn.on('close', () => {
    console.log('SSH connection closed')
    if (session?.headlessTerm) { session.headlessTerm.dispose(); session.headlessTerm = null }
    if (session?.ws?.readyState === WebSocket.OPEN) {
      session.ws.send(encodeFrame(MsgType.DISCONNECTED))
    }
    sessions.delete(tabId)
  })

  try {
    conn.connect(config)
  } catch (err) {
    ws.send(encodeJsonFrame(MsgType.ERROR, { message: `Connection failed: ${err.message}` }))
  }
}
