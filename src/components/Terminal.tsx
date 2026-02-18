'use client'

import { useEffect, useRef } from 'react'
import TerminalRenderer, { type TerminalRendererHandle } from './TerminalRenderer'

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

export default function Terminal({
  tabId,
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
  const rendererRef = useRef<TerminalRendererHandle>(null)
  const wsRef         = useRef<WebSocket | null>(null)
  const currentSizeRef = useRef({ cols: 0, rows: 0 })

  // Stable refs for callbacks
  const onConnectedRef    = useRef(onConnected)
  const onDisconnectedRef = useRef(onDisconnected)
  const onErrorRef        = useRef(onError)
  onConnectedRef.current    = onConnected
  onDisconnectedRef.current = onDisconnected
  onErrorRef.current        = onError

  // Config ref for reconnection (avoids re-running effect)
  const configRef = useRef({ host, port, username, password, privateKey, passphrase })
  configRef.current = { host, port, username, password, privateKey, passphrase }

  // Output batching — accumulate SSH chunks, flush every 16ms (one frame)
  // Prevents ghostty-web canvas from redrawing on every tiny SSH message
  const outputBufferRef = useRef('')
  const batchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushOutput = () => {
    batchTimeoutRef.current = null
    const buf = outputBufferRef.current
    if (!buf) return
    outputBufferRef.current = ''
    rendererRef.current?.write(buf, true)
  }

  const enqueueOutput = (chunk: string) => {
    outputBufferRef.current += chunk
    if (batchTimeoutRef.current === null) {
      batchTimeoutRef.current = setTimeout(flushOutput, 16)
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket connection effect
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let aborted       = false
    let isConnecting  = true
    let ws: WebSocket | null = null
    let pingInterval: ReturnType<typeof setInterval> | null = null
    let reconnectAttempts = 0
    const MAX_RECONNECTS  = 5

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl      = `${wsProtocol}//${window.location.host}/api/ssh`

    const handleMessage = (event: MessageEvent) => {
      if (aborted) return
      try {
        const msg = JSON.parse(event.data as string)
        switch (msg.type) {
          case 'connected':
            rendererRef.current?.write('\x1b[32mConnected!\x1b[0m\r\n\r\n')
            isConnecting = false
            reconnectAttempts = 0
            onConnectedRef.current?.()
            break

          case 'replay':
            // Full buffer replay — write all at once so the terminal lands in
            // the exact visual state (text + cursor position) from before refresh
            if (msg.data) {
              rendererRef.current?.write(msg.data, true)
              rendererRef.current?.scrollToBottom()
            }
            break

          case 'reconnected':
            isConnecting = false
            reconnectAttempts = 0
            onConnectedRef.current?.()
            // Tell the SSH server our actual terminal dimensions — the server
            // no longer hardcodes 80x24 on reconnect, so we must send this
            {
              const { cols, rows } = currentSizeRef.current
              if (cols && rows && wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }))
              }
            }
            break

          case 'data':
            enqueueOutput(msg.data)
            break

          case 'error':
            rendererRef.current?.write(`\x1b[31mError: ${msg.message}\x1b[0m\r\n`)
            onErrorRef.current?.(msg.message)
            break

          case 'disconnected':
            rendererRef.current?.write('\x1b[33m\r\nDisconnected from server.\x1b[0m\r\n')
            onDisconnectedRef.current?.()
            break
        }
      } catch (err) {
        console.error('[Terminal] message parse error:', err)
      }
    }

    const tryReconnect = () => {
      if (aborted) return
      if (reconnectAttempts >= MAX_RECONNECTS) {
        rendererRef.current?.write('\x1b[31mReconnection failed. Please reconnect manually.\x1b[0m\r\n')
        onDisconnectedRef.current?.()
        return
      }

      reconnectAttempts++
      rendererRef.current?.write(
        `\x1b[33mReconnecting (attempt ${reconnectAttempts}/${MAX_RECONNECTS})...\x1b[0m\r\n`
      )

      setTimeout(() => {
        if (aborted) return
        const newWs = new WebSocket(wsUrl)
        wsRef.current = newWs
        ws = newWs

        newWs.onopen = () => {
          // Send 'reconnect' so the server reuses the existing SSH session
          // instead of opening a new one
          newWs.send(JSON.stringify({ type: 'reconnect', tabId }))
        }
        newWs.onmessage = (e) => handleMessage(e)
        newWs.onerror   = () => tryReconnect()
        newWs.onclose   = () => { if (reconnectAttempts < MAX_RECONNECTS) tryReconnect() }
      }, 2000)
    }

    const connect = () => {
      if (aborted) return
      rendererRef.current?.write(`\x1b[33mConnecting to ${host}:${port}...\x1b[0m\r\n`)

      ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        // StrictMode cleanup may have already set aborted before we connected.
        // Close the now-unwanted socket cleanly instead of sending into a dead effect.
        if (aborted) { ws!.close(); return }
        ws!.send(JSON.stringify({
          type: 'auth', tabId, host, port, username,
          password, privateKey, passphrase,
        }))
      }
      ws.onmessage = (e) => handleMessage(e)
      ws.onerror   = () => {
        if (aborted) return  // StrictMode cleanup fires ws.close() mid-connect
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
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, 25000)
    }

    connect()

    return () => {
      aborted = true
      isConnecting = false
      if (pingInterval) clearInterval(pingInterval)
      if (batchTimeoutRef.current) {
        clearTimeout(batchTimeoutRef.current)
        batchTimeoutRef.current = null
      }
      outputBufferRef.current = ''
      // Only close OPEN sockets. If still CONNECTING, the onopen handler above
      // will see `aborted` and close it — avoids the browser warning
      // "WebSocket is closed before the connection is established".
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
      wsRef.current.send(JSON.stringify({ type: 'data', data }))
    }
  }

  const handleResize = (cols: number, rows: number) => {
    currentSizeRef.current = { cols, rows }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  }

  return (
    <TerminalRenderer
      ref={rendererRef}
      onData={handleData}
      onResize={handleResize}
    />
  )
}
