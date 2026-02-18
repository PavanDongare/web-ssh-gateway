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
const hostname = 'localhost'
const port     = 3000

const SESSION_TIMEOUT_MS = 300_000   // 5 minutes to reconnect
const MAX_OUTPUT_BUFFER  = 200 * 1024 // 200 KB ring buffer per session

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthMessage {
  tabId:       string
  host:        string
  port?:       number | string
  username:    string
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

interface Session {
  conn:         SshClient
  stream:       ClientChannel
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

// ---------------------------------------------------------------------------
// Session cleanup — every 30 s
// ---------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now()
  for (const [tabId, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      console.log(`Session ${tabId} expired, closing SSH`)
      if (session.headlessTerm) { session.headlessTerm.dispose(); session.headlessTerm = null }
      if (session.stream) session.stream.close()
      if (session.conn)   session.conn.end()
      sessions.delete(tabId)
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
// SSH auth + shell
// ---------------------------------------------------------------------------

function handleAuth(
  ws:      WebSocket,
  msg:     AuthMessage,
  onReady: (session: SessionInternal) => void,
): void {
  const { host, port: sshPort = 22, username, password, privateKey, passphrase, tabId } = msg

  if (!host || !username) {
    ws.send(encodeJsonFrame(MsgType.ERROR, { message: 'Host and username are required' }))
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

      const headlessTerm = createHeadlessTerminal(80, 24)

      // Ring buffer — avoids Buffer.concat on every chunk
      const ringBuf    = Buffer.allocUnsafe(MAX_OUTPUT_BUFFER)
      let   ringOffset = 0
      let   ringFull   = false

      session = {
        conn,
        stream,
        ws,
        lastActivity: Date.now(),
        headlessTerm,
        _ringBuf:    ringBuf,
        _ringOffset: ringOffset,
        _ringFull:   ringFull,
        get outputBuffer(): Buffer {
          if (!ringFull && ringOffset === 0) return Buffer.alloc(0)
          if (!ringFull) return ringBuf.slice(0, ringOffset)
          return Buffer.concat([ringBuf.slice(ringOffset), ringBuf.slice(0, ringOffset)])
        },
      }

      const appendToBuffer = (chunk: Buffer): void => {
        let src = 0
        while (src < chunk.length) {
          const space   = MAX_OUTPUT_BUFFER - ringOffset
          const toCopy  = Math.min(space, chunk.length - src)
          chunk.copy(ringBuf, ringOffset, src, src + toCopy)
          src       += toCopy
          ringOffset = (ringOffset + toCopy) % MAX_OUTPUT_BUFFER
          if (ringOffset === 0) ringFull = true
        }
        if (session?.headlessTerm) session.headlessTerm.write(chunk)
      }

      // Output batching — leading-edge flush (zero latency for echo),
      // then coalesce subsequent chunks in the same I/O tick via setImmediate.
      let batchChunks:  Buffer[] = []
      let batchPending           = false

      const flushBatch = (): void => {
        batchPending = false
        if (batchChunks.length === 0) return
        const combined = batchChunks.length === 1 ? batchChunks[0] : Buffer.concat(batchChunks)
        batchChunks = []
        if (session?.ws?.readyState === WebSocket.OPEN) {
          session.ws.send(encodeFrame(MsgType.SSH_DATA, combined))
        }
      }

      const enqueueChunk = (data: Buffer): void => {
        appendToBuffer(data)
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
        console.log('Stream closed')
        batchPending = false
        batchChunks  = []
        if (session?.headlessTerm) { session.headlessTerm.dispose(); session.headlessTerm = null }
        if (session?.ws?.readyState === WebSocket.OPEN) {
          session.ws.send(encodeFrame(MsgType.DISCONNECTED))
        }
        sessions.delete(tabId)
        conn.end()
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
    ws.send(encodeJsonFrame(MsgType.ERROR, { message: `Connection failed: ${(err as Error).message}` }))
  }
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
            console.log(`Creating new session for tab ${tabId} (${msg.username}@${msg.host})`)
            handleAuth(ws, msg, (session) => { sessions.set(tabId!, session) })
            break
          }

          case MsgType.RECONNECT: {
            const msg     = JSON.parse(frame.payload.toString('utf8')) as ReconnectMessage
            tabId         = msg.tabId
            const session = sessions.get(tabId)
            if (session?.conn) {
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
            if (dataSession?.stream?.writable) {
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
            const { cols, rows } = JSON.parse(frame.payload.toString('utf8')) as ResizeMessage
            const resizeSession  = tabId ? sessions.get(tabId) : undefined
            if (resizeSession?.stream) {
              resizeSession.stream.setWindow(rows, cols, 0, 0)
              resizeSession.lastActivity = Date.now()
              resizeSession.headlessTerm?.resize(cols, rows)
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
