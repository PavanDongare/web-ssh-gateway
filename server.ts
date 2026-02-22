/**
 * server.ts
 *
 * Custom Next.js server with WebSocket support for SSH connections.
 * Runs under tsx (no separate compile step needed).
 *
 * Imports MsgType, TerminalSnapshot, SnapshotCell and ATTR_* constants
 * directly from ws-protocol.ts — single source of truth, no manual sync.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'
import { parse } from 'url'
import next from 'next'
import WebSocket, { WebSocketServer } from 'ws'
import { Client as SshClient, ClientChannel, ConnectConfig } from 'ssh2'
import type { IPty } from 'node-pty'
import * as nodePty from 'node-pty'
import { Terminal as XTerminal } from '@xterm/xterm'

// Shared protocol — single source of truth (no more "keep in sync" comments)
import {
  MsgType,
  TerminalSnapshot,
  SnapshotCell,
  ATTR_BOLD,
  ATTR_ITALIC,
  ATTR_UNDERLINE,
  ATTR_DIM,
  ATTR_INVERSE,
  ATTR_INVISIBLE,
  ATTR_STRIKETHROUGH,
  ATTR_BLINK,
} from './src/lib/ws-protocol'

// Suppress the deprecation warning from xterm running in Node
process.emitWarning = () => {}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const dev      = process.env.NODE_ENV !== 'production'
const hostname = '0.0.0.0'
const port     = parseInt(process.env.PORT || '3001', 10)

const SESSION_TIMEOUT_MS = 300_000   // 5 minutes to reconnect
const MAX_OUTPUT_BUFFER  = 200 * 1024 // 200 KB ring buffer per session
const ENABLE_HEADLESS_SNAPSHOT = false // tmux handles session continuity

const MAX_SESSIONS_PER_IP = 5
const MAX_TOTAL_SESSIONS  = 20

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPrivateIP(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true
  
  // Basic private range checks
  const parts = host.split('.').map(Number)
  if (parts.length === 4) {
    if (parts[0] === 10) return true
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    if (parts[0] === 192 && parts[1] === 168) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthMessage {
  tabId:       string
  mode?:       'ssh' | 'local'
  host?:       string
  port?:       number | string
  username?:   string
  password?:   string
  privateKey?: string
  passphrase?: string
}

interface ReconnectMessage {
  tabId: string
}

interface ResizeMessage {
  cols: number
  rows: number
}

function tmuxSessionNameFromTabId(tabId: string): string {
  // tmux session names are safest with a restricted charset.
  const safe = tabId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)
  return `webssh_${safe || 'session'}`
}

interface Session {
  backend:      'ssh' | 'local'
  conn?:        SshClient
  stream?:      ClientChannel
  pty?:         IPty
  ws:           WebSocket | null
  lastActivity: number
  outputBuffer: Buffer          // getter — reads from ring buffer
  headlessTerm: XTerminal | null
}

// Internal session shape (includes ring-buffer state)
interface SessionInternal extends Omit<Session, 'outputBuffer'> {
  _ringBuf:    Buffer
  _ringOffset: number
  _ringFull:   boolean
  outputBuffer: Buffer
}
const payloadDecoder = new TextDecoder()

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

const sessions = new Map<string, SessionInternal>()

// ---------------------------------------------------------------------------
// Binary frame helpers (Node-side, Buffer-based)
// These mirror the Uint8Array helpers in ws-protocol.ts but use Buffer
// so they work natively with the `ws` library on Node.
// ---------------------------------------------------------------------------

/** Encode a binary frame */
function encodeFrame(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const frame = Buffer.allocUnsafe(3 + payload.length)
  frame.writeUInt8(type, 0)
  frame.writeUInt16LE(payload.length, 1)
  payload.copy(frame, 3)
  return frame
}

/** Encode a frame with a JSON payload */
function encodeJsonFrame(type: number, data: unknown): Buffer {
  return encodeFrame(type, Buffer.from(JSON.stringify(data), 'utf8'))
}

/** Decoded frame */
interface DecodedFrame {
  type:    number
  payload: Buffer
}

/** Decode a binary frame. Returns null on error. */
function decodeFrame(raw: Buffer): DecodedFrame | null {
  if (raw.length < 3) return null
  const type   = raw.readUInt8(0)
  const payLen = raw.readUInt16LE(1)
  if (raw.length < 3 + payLen) return null
  const payload = raw.slice(3, 3 + payLen)
  return { type, payload }
}

// ---------------------------------------------------------------------------
// Headless terminal helpers (Fix 7)
// ---------------------------------------------------------------------------

function createHeadlessTerminal(cols: number, rows: number): XTerminal {
  return new XTerminal({
    cols,
    rows,
    allowProposedApi: true,
    scrollback: 1000,
  })
}

function serializeSnapshot(term: XTerminal): TerminalSnapshot {
  const buf    = term.buffer.active
  const cols   = term.cols
  const rows   = term.rows
  const bufLen = buf.length

  const startLine = Math.max(0, bufLen - rows)
  const lines: SnapshotCell[][] = []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cellObj: any = {}

  for (let r = 0; r < rows; r++) {
    const line  = buf.getLine(startLine + r)
    const cells: SnapshotCell[] = []

    if (!line) {
      cells.push({ ch: ' ', w: 1, fg: -1, bg: -1, at: 0 })
    } else {
      for (let c = 0; c < cols; c++) {
        const cell = line.getCell(c, cellObj)
        if (!cell) continue

        const w = cell.getWidth()
        if (w === 0) continue // continuation cell for wide char

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
          fg: fg == null ? -1 : fg,
          bg: bg == null ? -1 : bg,
          at,
        })
      }
    }

    lines.push(cells)
  }

  return {
    cols,
    rows,
    cursorX:   buf.cursorX,
    cursorY:   buf.cursorY,
    viewportY: Math.max(0, bufLen - rows - buf.viewportY),
    lines,
  }
}

function createSessionState(
  backend: 'ssh' | 'local',
  ws: WebSocket,
  extras: { conn?: SshClient; stream?: ClientChannel; pty?: IPty },
): SessionInternal {
  const ringBuf = Buffer.allocUnsafe(MAX_OUTPUT_BUFFER)
  const ringOffset = 0
  const ringFull = false

  return {
    backend,
    ...extras,
    ws,
    lastActivity: Date.now(),
    headlessTerm: ENABLE_HEADLESS_SNAPSHOT ? createHeadlessTerminal(80, 24) : null,
    _ringBuf: ringBuf,
    _ringOffset: ringOffset,
    _ringFull: ringFull,
    get outputBuffer(): Buffer {
      if (!ringFull && ringOffset === 0) return Buffer.alloc(0)
      if (!ringFull) return ringBuf.slice(0, ringOffset)
      return Buffer.concat([ringBuf.slice(ringOffset), ringBuf.slice(0, ringOffset)])
    },
  }
}

function appendOutput(session: SessionInternal, chunk: Buffer): void {
  let src = 0
  while (src < chunk.length) {
    const space = MAX_OUTPUT_BUFFER - session._ringOffset
    const toCopy = Math.min(space, chunk.length - src)
    chunk.copy(session._ringBuf, session._ringOffset, src, src + toCopy)
    src += toCopy
    session._ringOffset = (session._ringOffset + toCopy) % MAX_OUTPUT_BUFFER
    if (session._ringOffset === 0) session._ringFull = true
  }
  if (ENABLE_HEADLESS_SNAPSHOT && session.headlessTerm) {
    session.headlessTerm.write(chunk)
  }
}

function closeSession(tabId: string, session: SessionInternal): void {
  if (!sessions.has(tabId)) return
  if (session.headlessTerm) {
    session.headlessTerm.dispose()
    session.headlessTerm = null
  }
  if (session.backend === 'ssh') {
    session.stream?.close()
    session.conn?.end()
  } else {
    session.pty?.kill()
  }
  sessions.delete(tabId)
}

function writeToSession(session: SessionInternal, payload: Buffer): void {
  if (session.backend === 'ssh' && session.stream?.writable) {
    session.stream.write(payload)
    return
  }
  if (session.backend === 'local' && session.pty) {
    session.pty.write(payloadDecoder.decode(payload))
  }
}

function resizeSession(session: SessionInternal, cols: number, rows: number): void {
  if (session.backend === 'ssh' && session.stream) {
    session.stream.setWindow(rows, cols, 0, 0)
  }
  if (session.backend === 'local' && session.pty) {
    session.pty.resize(cols, rows)
  }
  session.headlessTerm?.resize(cols, rows)
}

// ---------------------------------------------------------------------------
// Session cleanup — every 30 s
// ---------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now()
  for (const [tabId, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      console.log(`Session ${tabId} expired, closing ${session.backend} backend`)
      closeSession(tabId, session)
    }
  }
}, 30_000)

// ---------------------------------------------------------------------------
// Attach a WebSocket to an existing session (reconnect path)
// ---------------------------------------------------------------------------

function attachToSession(ws: WebSocket, tabId: string, session: SessionInternal): void {
  session.ws           = ws
  session.lastActivity = Date.now()

  if (session.headlessTerm) {
    try {
      const snapshot = serializeSnapshot(session.headlessTerm)
      ws.send(encodeJsonFrame(MsgType.SNAPSHOT, snapshot))
      console.log(`Sent terminal snapshot for session ${tabId} (${snapshot.cols}x${snapshot.rows}, ${snapshot.lines.length} lines)`)
    } catch (err) {
      console.error(`Failed to serialize snapshot for ${tabId}, falling back to replay:`, err)
      const buf = session.outputBuffer
      if (buf.length > 0) ws.send(encodeFrame(MsgType.REPLAY, buf))
    }
  } else {
    const buf = session.outputBuffer
    if (buf.length > 0) ws.send(encodeFrame(MsgType.REPLAY, buf))
  }

  ws.send(encodeFrame(MsgType.RECONNECTED))
  console.log(`Reattached WebSocket to session ${tabId}`)
}

// ---------------------------------------------------------------------------
// Auth/session bootstrap
// ---------------------------------------------------------------------------

function handleSshAuth(
  ws: WebSocket,
  msg: AuthMessage,
  onReady: (session: SessionInternal) => void,
): void {
  const { host, port: sshPort = 22, username, password, privateKey, passphrase, tabId } = msg

  if (!host || !username) {
    ws.send(encodeJsonFrame(MsgType.ERROR, { message: 'Host and username are required' }))
    return
  }

  if (isPrivateIP(host)) {
    console.warn(`Blocked SSH connection attempt to private/local host: ${host}`)
    ws.send(encodeJsonFrame(MsgType.ERROR, { message: 'Connections to local/private addresses are not allowed.' }))
    return
  }

  if (!password && !privateKey) {
    ws.send(encodeJsonFrame(MsgType.ERROR, { message: 'Password or private key is required' }))
    return
  }

  const conn = new SshClient()
  let session: SessionInternal | null = null

  const config: ConnectConfig = {
    host,
    port:              parseInt(String(sshPort)) || 22,
    username,
    readyTimeout:      20_000,
    keepaliveInterval: 30_000,
  }

  if (password)        config.password   = password
  else if (privateKey) {
    config.privateKey = privateKey
    if (passphrase)    config.passphrase = passphrase
  }

  conn.on('ready', () => {
    console.log(`SSH connected to ${host}:${sshPort}`)

    conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
      if (err) {
        ws.send(encodeJsonFrame(MsgType.ERROR, { message: `Shell error: ${err.message}` }))
        conn.end()
        return
      }

      console.log('Shell opened')
      const tmuxSession = tmuxSessionNameFromTabId(tabId)
      // Keep tmux for session persistence but hide its bottom status line
      // so the terminal viewport is not reduced by one row.
      stream.write(
        `tmux new-session -Ad -s ${tmuxSession}\n` +
        `tmux set-option -t ${tmuxSession} status off\n` +
        `tmux attach-session -t ${tmuxSession}\n`
      )

      session = createSessionState('ssh', ws, { conn, stream })

      let batchChunks: Buffer[] = []
      let batchPending = false

      const flushBatch = (): void => {
        batchPending = false
        if (batchChunks.length === 0 || !session) return
        const combined = batchChunks.length === 1 ? batchChunks[0] : Buffer.concat(batchChunks)
        batchChunks = []
        if (session.ws?.readyState === WebSocket.OPEN) {
          session.ws.send(encodeFrame(MsgType.SSH_DATA, combined))
        }
      }

      const enqueueChunk = (data: Buffer): void => {
        if (!session) return
        appendOutput(session, data)
        const isFirst = batchChunks.length === 0
        batchChunks.push(data)
        if (isFirst) {
          flushBatch()
          if (!batchPending) { batchPending = true; setImmediate(flushBatch) }
        } else if (!batchPending) {
          batchPending = true
          setImmediate(flushBatch)
        }
      }

      stream.on('data', (data: Buffer) => enqueueChunk(data))
      stream.stderr.on('data', (data: Buffer) => enqueueChunk(data))

      stream.on('close', () => {
        console.log('SSH stream closed')
        batchPending = false
        batchChunks  = []
        if (session?.ws?.readyState === WebSocket.OPEN) {
          session.ws.send(encodeFrame(MsgType.DISCONNECTED))
        }
        if (session) closeSession(tabId, session)
      })

      ws.send(encodeFrame(MsgType.CONNECTED))
      onReady(session)
    })
  })

  conn.on('error', (err: Error) => {
    console.error('SSH connection error:', err)
    ws.send(encodeJsonFrame(MsgType.ERROR, { message: `SSH error: ${err.message}` }))
  })

  conn.on('close', () => {
    if (session?.ws?.readyState === WebSocket.OPEN) {
      session.ws.send(encodeFrame(MsgType.DISCONNECTED))
    }
    if (session) closeSession(tabId, session)
  })

  try {
    conn.connect(config)
  } catch (err) {
    ws.send(encodeJsonFrame(MsgType.ERROR, { message: `Connection failed: ${(err as Error).message}` }))
  }
}

function handleLocalAuth(
  ws: WebSocket,
  msg: AuthMessage,
  onReady: (session: SessionInternal) => void,
): void {
  const adminPassword = process.env.ADMIN_PASSWORD
  
  if (!adminPassword) {
    ws.send(encodeJsonFrame(MsgType.ERROR, { message: 'Local mode is disabled (ADMIN_PASSWORD not set on server)' }))
    return
  }

  if (msg.password !== adminPassword) {
    console.warn(`Unauthorized Local access attempt from tab ${msg.tabId}`)
    ws.send(encodeJsonFrame(MsgType.ERROR, { message: 'Incorrect Admin Password' }))
    return
  }

  const shell = process.env.SHELL || '/bin/zsh'
  const localEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') localEnv[key] = value
  }
  delete localEnv.npm_config_prefix

  try {
    const pty = nodePty.spawn(shell, ['-i', '-l'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.env.HOME || process.cwd(),
      env: localEnv,
    })

    const session = createSessionState('local', ws, { pty })
    onReady(session)
    ws.send(encodeFrame(MsgType.CONNECTED))

    let batchChunks: Buffer[] = []
    let batchPending = false

    const flushBatch = (): void => {
      batchPending = false
      if (batchChunks.length === 0) return
      const combined = batchChunks.length === 1 ? batchChunks[0] : Buffer.concat(batchChunks)
      batchChunks = []
      if (session.ws?.readyState === WebSocket.OPEN) {
        session.ws.send(encodeFrame(MsgType.SSH_DATA, combined))
      }
    }

    pty.onData((text: string) => {
      const data = Buffer.from(text, 'utf8')
      appendOutput(session, data)
      const isFirst = batchChunks.length === 0
      batchChunks.push(data)
      if (isFirst) {
        flushBatch()
        if (!batchPending) { batchPending = true; setImmediate(flushBatch) }
      } else if (!batchPending) {
        batchPending = true
        setImmediate(flushBatch)
      }
    })

    pty.onExit(() => {
      batchPending = false
      batchChunks  = []
      if (session.ws?.readyState === WebSocket.OPEN) {
        session.ws.send(encodeFrame(MsgType.DISCONNECTED))
      }
      closeSession(msg.tabId, session)
    })
  } catch (err) {
    ws.send(encodeJsonFrame(MsgType.ERROR, { message: `Local terminal failed: ${(err as Error).message}` }))
  }
}

function handleAuth(
  ws: WebSocket,
  msg: AuthMessage,
  onReady: (session: SessionInternal) => void,
): void {
  if (sessions.size >= MAX_TOTAL_SESSIONS) {
    console.warn('Max total sessions reached. Blocking new connection.')
    ws.send(encodeJsonFrame(MsgType.ERROR, { message: 'Server is at maximum session capacity. Please try again later.' }))
    return
  }

  const mode = msg.mode ?? 'ssh'
  if (mode === 'local') {
    // Each local connection gets its own session - no sharing
    handleLocalAuth(ws, msg, onReady)
    return
  }
  handleSshAuth(ws, msg, onReady)
}

// ---------------------------------------------------------------------------
// Bootstrap Next.js + HTTP + WebSocket server
// ---------------------------------------------------------------------------

const app    = next({ dev, hostname, port })
const handle = app.getRequestHandler()

app.prepare().then(async () => {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const parsedUrl = parse(req.url ?? '/', true)
      await handle(req, res, parsedUrl)
    } catch (err) {
      console.error('Error handling', req.url, err)
      res.statusCode = 500
      res.end('internal server error')
    }
  })

  // perMessageDeflate: false — SSH data is already binary/incompressible.
  const wss = new WebSocketServer({ noServer: true, clientTracking: true, perMessageDeflate: false })

  const nextUpgradeHandler = await app.getUpgradeHandler()

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url ?? '/')
    if (pathname === '/api/ssh') {
      wss.handleUpgrade(req, socket, head, (client) => {
        wss.emit('connection', client, req)
      })
    } else {
      nextUpgradeHandler(req, socket, head)
    }
  })

  // Heartbeat — ping every 30 s, terminate dead connections
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const wse = ws as WebSocket & { isAlive: boolean }
      if (!wse.isAlive) { console.log('Terminating dead WebSocket'); return wse.terminate() }
      wse.isAlive = false
      wse.ping()
    })
  }, 30_000)

  wss.on('close', () => clearInterval(heartbeatInterval))

  wss.on('connection', (ws: WebSocket & { isAlive?: boolean }) => {
    let tabId: string | null = null

    ws.isAlive   = true
    ws.binaryType = 'nodebuffer' as never  // ws lib uses this string internally

    ws.on('pong', () => { ws.isAlive = true })

    console.log('New WebSocket connection')

    ws.on('message', (raw: Buffer) => {
      try {
        const frame = decodeFrame(raw)
        if (!frame) { console.warn('Malformed frame, ignoring'); return }

        switch (frame.type) {
          case MsgType.AUTH: {
            const msg = JSON.parse(frame.payload.toString('utf8')) as AuthMessage
            tabId = msg.tabId
            console.log(`Creating new ${msg.mode ?? 'ssh'} session for tab ${tabId}`)
            handleAuth(ws, msg, (session) => { sessions.set(tabId!, session) })
            break
          }

          case MsgType.RECONNECT: {
            const msg     = JSON.parse(frame.payload.toString('utf8')) as ReconnectMessage
            tabId         = msg.tabId
            const session = sessions.get(tabId)
            if (session) {
              console.log(`Reconnecting to session ${tabId}`)
              attachToSession(ws, tabId, session)
            } else {
              ws.send(encodeJsonFrame(MsgType.ERROR, { message: 'Session expired. Please reconnect.' }))
            }
            break
          }

          case MsgType.DATA: {
            // Raw binary keystrokes — no UTF-8 decode, no JSON parse
            const dataSession = tabId ? sessions.get(tabId) : undefined
            if (dataSession) {
              writeToSession(dataSession, frame.payload)
              dataSession.lastActivity = Date.now()
            }
            break
          }

          case MsgType.RESIZE: {
            const { cols, rows } = JSON.parse(frame.payload.toString('utf8')) as ResizeMessage
            const activeSession  = tabId ? sessions.get(tabId) : undefined
            if (activeSession) {
              resizeSession(activeSession, cols, rows)
              activeSession.lastActivity = Date.now()
            }
            break
          }

          case MsgType.PING: {
            const pingSession = tabId ? sessions.get(tabId) : undefined
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
      if (tabId) {
        const session = sessions.get(tabId)
        if (session) {
          session.ws           = null
          session.lastActivity = Date.now()
          console.log(`Session ${tabId} kept alive for reconnection (${SESSION_TIMEOUT_MS}ms)`)
        }
      }
    })

    ws.on('error', (err: Error) => console.error('WebSocket error:', err))
  })

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`)
    console.log(`> WebSocket endpoint: ws://${hostname}:${port}/api/ssh`)
    console.log(`> Session persistence: ${SESSION_TIMEOUT_MS}ms`)
    console.log(`> Protocol: binary frames + headless terminal snapshot (Fix 6+7)`)
  })
})
