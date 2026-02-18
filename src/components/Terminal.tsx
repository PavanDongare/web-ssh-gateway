'use client'

import { useEffect, useRef, useState } from 'react'
import TerminalRenderer, { type TerminalRendererHandle } from './TerminalRenderer'
import {
  MsgType,
  encodeFrame,
  encodeJsonFrame,
  decodeFrame,
  decodeJsonPayload,
  type TerminalSnapshot,
  type SnapshotCell,
  ATTR_BOLD,
  ATTR_ITALIC,
  ATTR_UNDERLINE,
  ATTR_DIM,
  ATTR_INVERSE,
  ATTR_INVISIBLE,
  ATTR_STRIKETHROUGH,
  ATTR_BLINK,
} from '@/lib/ws-protocol'

interface TerminalProps {
  tabId: string
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  onConnected?: () => void
  onDisconnected?: () => void
  onError?: (message: string) => void
}

// ---------------------------------------------------------------------------
// Fix 1: Persist tabId across page refreshes so the server can reuse the SSH session
// ---------------------------------------------------------------------------
function getOrCreateTabId(propTabId: string): string {
  if (typeof window === 'undefined') return propTabId
  const key = `ssh_tab_id_${propTabId}`
  const stored = sessionStorage.getItem(key)
  if (stored) return stored
  sessionStorage.setItem(key, propTabId)
  return propTabId
}

// ---------------------------------------------------------------------------
// Fix 2: Exponential backoff helper
// ---------------------------------------------------------------------------
function backoffDelay(attempt: number): number {
  // 1s → 2s → 4s → 8s → 16s, capped at 30s
  return Math.min(1000 * Math.pow(2, attempt), 30000)
}

// ---------------------------------------------------------------------------
// Fix 6: Singleton codec instances — avoid per-call allocation
// ---------------------------------------------------------------------------
const sshDecoder  = new TextDecoder()
const sshEncoder  = new TextEncoder()  // for encoding keystrokes

// ---------------------------------------------------------------------------
// Fix 7: Reconstruct VT100 escape sequences from a TerminalSnapshot
// so Ghostty renders the exact terminal state (colors, cursor, TUI apps).
// ---------------------------------------------------------------------------
// Reusable SGR array — avoids allocating a new array for every terminal cell
// during snapshot rendering (can be 11,000+ cells for a large terminal).
const _sgr: number[] = []

function snapshotToVT(snap: TerminalSnapshot): string {
  const parts: string[] = []

  // Clear screen and move to top-left
  parts.push('\x1b[2J\x1b[H')

  for (let r = 0; r < snap.lines.length; r++) {
    const cells = snap.lines[r]

    for (const cell of cells) {
      if (cell.w === 0) continue  // wide char continuation

      // Reuse _sgr array — reset length to 0, then push codes
      _sgr.length = 0
      _sgr.push(0)  // always reset first

      // Attributes
      if (cell.at & ATTR_BOLD)          _sgr.push(1)
      if (cell.at & ATTR_DIM)           _sgr.push(2)
      if (cell.at & ATTR_ITALIC)        _sgr.push(3)
      if (cell.at & ATTR_UNDERLINE)     _sgr.push(4)
      if (cell.at & ATTR_BLINK)         _sgr.push(5)
      if (cell.at & ATTR_INVERSE)       _sgr.push(7)
      if (cell.at & ATTR_INVISIBLE)     _sgr.push(8)
      if (cell.at & ATTR_STRIKETHROUGH) _sgr.push(9)

      // Foreground color
      if (cell.fg >= 0) {
        if (cell.fg < 8) {
          _sgr.push(30 + cell.fg)
        } else if (cell.fg < 16) {
          _sgr.push(90 + (cell.fg - 8))
        } else if (cell.fg < 256) {
          _sgr.push(38, 5, cell.fg)
        } else {
          // 24-bit RGB encoded as (r<<16|g<<8|b)
          _sgr.push(38, 2, (cell.fg >> 16) & 0xff, (cell.fg >> 8) & 0xff, cell.fg & 0xff)
        }
      }

      // Background color
      if (cell.bg >= 0) {
        if (cell.bg < 8) {
          _sgr.push(40 + cell.bg)
        } else if (cell.bg < 16) {
          _sgr.push(100 + (cell.bg - 8))
        } else if (cell.bg < 256) {
          _sgr.push(48, 5, cell.bg)
        } else {
          _sgr.push(48, 2, (cell.bg >> 16) & 0xff, (cell.bg >> 8) & 0xff, cell.bg & 0xff)
        }
      }

      parts.push(`\x1b[${_sgr.join(';')}m`)
      parts.push(cell.ch)
    }

    // Reset at end of each line, move to next line
    parts.push('\x1b[0m')
    if (r < snap.lines.length - 1) {
      parts.push('\r\n')
    }
  }

  // Reset all attributes + position cursor
  parts.push(`\x1b[0m\x1b[${snap.cursorY + 1};${snap.cursorX + 1}H`)

  return parts.join('')
}

export default function Terminal({
  tabId: propTabId,
  host,
  port,
  username,
  password,
  privateKey,
  passphrase,
  onConnected,
  onDisconnected,
  onError,
}: TerminalProps) {
  const rendererRef    = useRef<TerminalRendererHandle>(null)
  const wsRef          = useRef<WebSocket | null>(null)
  const currentSizeRef = useRef({ cols: 0, rows: 0 })

  // Fix 1: stable tabId that survives page refresh
  const tabId = getOrCreateTabId(propTabId)

  // Fix 2: show a manual reconnect button after max retries
  const [showReconnectBtn, setShowReconnectBtn] = useState(false)
  const reconnectFnRef = useRef<(() => void) | null>(null)

  // Stable refs for callbacks
  const onConnectedRef    = useRef(onConnected)
  const onDisconnectedRef = useRef(onDisconnected)
  const onErrorRef        = useRef(onError)
  onConnectedRef.current    = onConnected
  onDisconnectedRef.current = onDisconnected
  onErrorRef.current        = onError

  // Output batching — leading-edge flush for zero-latency echo, trailing batch for bursts.
  //
  // Strategy:
  //   1. First chunk in a burst → flush immediately (0ms) so typed chars echo instantly
  //   2. Any chunks arriving within the same rAF → batched into one render call
  //   3. rAF fires (~16ms) → flush remaining buffered chunks
  //
  // This eliminates the 16ms echo delay while still coalescing rapid SSH output
  // (e.g. `ls` output, vim redraws) into single canvas renders.
  const outputBufferRef  = useRef<Uint8Array[]>([])
  const batchRafRef      = useRef<number | null>(null)

  const flushOutput = () => {
    batchRafRef.current = null
    const chunks = outputBufferRef.current
    if (chunks.length === 0) return
    outputBufferRef.current = []
    // Decode all accumulated binary chunks at once — preserves multi-byte sequences
    const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0))
    let offset = 0
    for (const c of chunks) { combined.set(c, offset); offset += c.length }
    const text = sshDecoder.decode(combined, { stream: true })
    rendererRef.current?.write(text, true)
  }

  const enqueueOutput = (chunk: Uint8Array) => {
    const isFirstChunk = outputBufferRef.current.length === 0
    outputBufferRef.current.push(chunk)

    if (isFirstChunk) {
      // Flush immediately for zero-latency echo (typed char appears right away)
      flushOutput()
      // Schedule a rAF to catch any chunks that arrive in the same frame
      if (batchRafRef.current === null) {
        batchRafRef.current = requestAnimationFrame(flushOutput)
      }
    } else if (batchRafRef.current === null) {
      // Already flushed the first chunk; batch the rest into next frame
      batchRafRef.current = requestAnimationFrame(flushOutput)
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket connection effect
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let aborted      = false
    let isConnecting = true
    let ws: WebSocket | null = null
    let pingInterval: ReturnType<typeof setInterval> | null = null
    let reconnectAttempts = 0

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl      = `${wsProtocol}//${window.location.host}/api/ssh`

    // Fix 6: handle binary frames from server
    const handleMessage = (event: MessageEvent<ArrayBuffer>) => {
      if (aborted) return
      try {
        const frame = decodeFrame(event.data)
        if (!frame) { console.warn('[Terminal] malformed frame'); return }

        switch (frame.type) {
          case MsgType.CONNECTED:
            // Erase the "Connecting to …" line so it doesn't linger on success
            rendererRef.current?.write('\x1b[2K\x1b[1A\x1b[2K\x1b[G')
            isConnecting = false
            reconnectAttempts = 0
            setShowReconnectBtn(false)
            onConnectedRef.current?.()
            break

          case MsgType.REPLAY:
            // Full buffer replay — binary-safe, write all at once
            if (frame.payload.length > 0) {
              const text = sshDecoder.decode(frame.payload)
              rendererRef.current?.write(text, true)
              rendererRef.current?.scrollToBottom()
            }
            break

          case MsgType.RECONNECTED:
            isConnecting = false
            reconnectAttempts = 0
            setShowReconnectBtn(false)
            onConnectedRef.current?.()
            // Tell the SSH server our actual terminal dimensions
            {
              const { cols, rows } = currentSizeRef.current
              if (cols && rows && wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(encodeJsonFrame(MsgType.RESIZE, { cols, rows }))
              }
            }
            break

          case MsgType.SSH_DATA:
            // Fix 6: raw binary chunk — enqueue for batched decode
            enqueueOutput(frame.payload.slice()) // slice to own the memory
            break

          case MsgType.ERROR: {
            const { message } = decodeJsonPayload<{ message: string }>(frame.payload)
            rendererRef.current?.write(`\x1b[31mError: ${message}\x1b[0m\r\n`)
            onErrorRef.current?.(message)
            break
          }

          case MsgType.SNAPSHOT: {
            // Fix 7: exact terminal state from server's headless xterm
            // Convert snapshot cells → VT100 escape sequences → feed to Ghostty
            // This renders vim/htop/tmux correctly on reconnect, no raw replay mangling
            const snap = decodeJsonPayload<TerminalSnapshot>(frame.payload)
            const vt = snapshotToVT(snap)
            rendererRef.current?.write(vt, false)  // false = don't auto-scroll (cursor is already positioned)
            rendererRef.current?.scrollToBottom()
            break
          }

          case MsgType.DISCONNECTED:
            rendererRef.current?.write('\x1b[33m\r\nDisconnected from server.\x1b[0m\r\n')
            onDisconnectedRef.current?.()
            break
        }
      } catch (err) {
        console.error('[Terminal] frame parse error:', err)
      }
    }

    // Fix 2: exponential backoff reconnect with manual retry button after exhaustion
    const tryReconnect = () => {
      if (aborted) return

      const delay = backoffDelay(reconnectAttempts)
      reconnectAttempts++

      // After 5 attempts (~63s total), show the manual reconnect button
      if (reconnectAttempts > 5) {
        rendererRef.current?.write(
          '\x1b[31mReconnection failed. Use the Reconnect button below.\x1b[0m\r\n'
        )
        setShowReconnectBtn(true)
        onDisconnectedRef.current?.()
        return
      }

      rendererRef.current?.write(
        `\x1b[33mReconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts}/5)...\x1b[0m\r\n`
      )

      setTimeout(() => {
        if (aborted) return
        const newWs = new WebSocket(wsUrl)
        newWs.binaryType = 'arraybuffer'
        wsRef.current = newWs
        ws = newWs

        newWs.onopen = () => {
          if (aborted) { newWs.close(); return }
          newWs.send(encodeJsonFrame(MsgType.RECONNECT, { tabId }))
        }
        newWs.onmessage = (e) => handleMessage(e as MessageEvent<ArrayBuffer>)
        newWs.onerror   = () => { if (!aborted) tryReconnect() }
        newWs.onclose   = () => { if (!aborted && reconnectAttempts <= 5) tryReconnect() }
      }, delay)
    }

    const connect = () => {
      if (aborted) return

      ws = new WebSocket(wsUrl)
      // Fix 6: receive binary frames as ArrayBuffer
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ws.onopen = () => {
        if (aborted) { ws!.close(); return }
        // Write "Connecting…" only once the socket is actually open (avoids
        // StrictMode double-mount writing it twice in development).
        rendererRef.current?.write(`\x1b[33mConnecting to ${host}:${port}...\x1b[0m\r\n`)
        // Fix 6: send auth as binary frame with JSON payload
        ws!.send(encodeJsonFrame(MsgType.AUTH, {
          tabId, host, port, username,
          password, privateKey, passphrase,
        }))
      }
      ws.onmessage = (e) => handleMessage(e as MessageEvent<ArrayBuffer>)
      ws.onerror   = () => {
        if (aborted) return
        rendererRef.current?.write('\x1b[31mWebSocket error.\x1b[0m\r\n')
        onErrorRef.current?.('WebSocket connection failed')
      }
      ws.onclose = () => {
        if (!isConnecting && !aborted) {
          rendererRef.current?.write('\x1b[33m\r\nConnection lost. Attempting to reconnect...\x1b[0m\r\n')
          tryReconnect()
        }
      }

      // Keepalive
      pingInterval = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(encodeFrame(MsgType.PING))
        }
      }, 25000)
    }

    // Expose manual reconnect for the button
    reconnectFnRef.current = () => {
      if (aborted) return
      reconnectAttempts = 0
      setShowReconnectBtn(false)
      rendererRef.current?.write('\x1b[33mManual reconnect...\x1b[0m\r\n')
      connect()
    }

    connect()

    return () => {
      aborted = true
      isConnecting = false
      reconnectFnRef.current = null
      if (pingInterval) clearInterval(pingInterval)
      if (batchRafRef.current !== null) {
        cancelAnimationFrame(batchRafRef.current)
        batchRafRef.current = null
      }
      outputBufferRef.current = []
      if (ws?.readyState === WebSocket.OPEN) {
        ws.close()
      }
      wsRef.current = null
    }
  }, [tabId, host, port, username]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Send keystrokes and resize to SSH server
  // ---------------------------------------------------------------------------
  const handleData = (data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      // Use singleton encoder — avoids allocating a new TextEncoder on every keypress
      wsRef.current.send(encodeFrame(MsgType.DATA, sshEncoder.encode(data)))
    }
  }

  const handleResize = (cols: number, rows: number) => {
    currentSizeRef.current = { cols, rows }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(encodeJsonFrame(MsgType.RESIZE, { cols, rows }))
    }
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <TerminalRenderer
        ref={rendererRef}
        onData={handleData}
        onResize={handleResize}
        onTranscript={handleData}
      />

      {/* Fix 2: Manual reconnect button shown after exponential backoff exhausted */}
      {showReconnectBtn && (
        <div
          style={{
            position:       'absolute',
            bottom:         48,
            left:           '50%',
            transform:      'translateX(-50%)',
            zIndex:         30,
            display:        'flex',
            flexDirection:  'column',
            alignItems:     'center',
            gap:            8,
          }}
        >
          <button
            type="button"
            onClick={() => reconnectFnRef.current?.()}
            style={{
              background:    '#ef4444',
              color:         '#fff',
              border:        'none',
              borderRadius:  6,
              padding:       '8px 20px',
              fontFamily:    'ui-monospace, SFMono-Regular, "SF Mono", Consolas, monospace',
              fontSize:      13,
              fontWeight:    600,
              cursor:        'pointer',
              boxShadow:     '0 2px 8px rgba(0,0,0,0.3)',
              letterSpacing: '0.02em',
            }}
          >
            ↺ Reconnect
          </button>
          <span
            style={{
              color:      'rgba(255,255,255,0.55)',
              fontSize:   11,
              fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Consolas, monospace',
            }}
          >
            Session may still be alive on the server
          </span>
        </div>
      )}
    </div>
  )
}
