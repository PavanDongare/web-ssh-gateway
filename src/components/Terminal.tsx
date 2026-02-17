'use client'

import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

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
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  
  const mountCountRef = useRef(0)
  const isConnectingRef = useRef(false)
  
  const configRef = useRef({ host, port, username, password, privateKey, passphrase })

  const onConnectedRef = useRef(onConnected)
  const onDisconnectedRef = useRef(onDisconnected)
  const onErrorRef = useRef(onError)

  onConnectedRef.current = onConnected
  onDisconnectedRef.current = onDisconnected
  onErrorRef.current = onError

  useEffect(() => {
    mountCountRef.current++
    console.log('[Terminal] useEffect run #' + mountCountRef.current)
    
    if (mountCountRef.current < 2) {
      console.log('[Terminal] Skipping - StrictMode mount #' + mountCountRef.current)
      return
    }
    
    if (!containerRef.current) {
      console.log('[Terminal] Skipping - no container')
      return
    }
    
    isConnectingRef.current = true
    console.log('[Terminal] Creating terminal for', host, port, username)

    const terminal = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1a1a2e',
        foreground: '#eaeaea',
        cursor: '#ffffff',
        cursorAccent: '#1a1a2e',
      },
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    fitAddon.fit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    terminal.writeln(`\x1b[33mConnecting to ${host}:${port}...\x1b[0m`)

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProtocol}//${window.location.host}/api/ssh`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'auth',
        tabId,
        host,
        port,
        username,
        password,
        privateKey,
        passphrase,
      }))
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        switch (msg.type) {
          case 'connected':
            terminal.writeln('\x1b[32mConnected!\x1b[0m')
            terminal.writeln('')
            isConnectingRef.current = false
            onConnectedRef.current?.()
            break
          case 'reconnected':
            terminal.writeln('\x1b[32mReconnected!\x1b[0m')
            isConnectingRef.current = false
            onConnectedRef.current?.()
            break
          case 'data':
            terminal.write(msg.data)
            break
          case 'error':
            terminal.writeln(`\x1b[31mError: ${msg.message}\x1b[0m`)
            onErrorRef.current?.(msg.message)
            break
          case 'disconnected':
            terminal.writeln('\x1b[33m\r\nDisconnected from server.\x1b[0m')
            onDisconnectedRef.current?.()
            break
        }
      } catch (err) {
        console.error('Error parsing message:', err)
      }
    }

    ws.onerror = () => {
      terminal.writeln('\x1b[31mWebSocket error.\x1b[0m')
      onErrorRef.current?.('WebSocket connection failed')
    }

    let reconnectAttempts = 0
    const maxReconnectAttempts = 5

    ws.onclose = () => {
      if (!isConnectingRef.current) {
        terminal.writeln('\x1b[33m\r\nConnection lost. Attempting to reconnect...\x1b[0m')
        tryReconnect(terminal, configRef.current, tabId)
      }
    }

    async function tryReconnect(term: XTerm, config: typeof configRef.current, id: string) {
      if (reconnectAttempts >= maxReconnectAttempts) {
        term.writeln('\x1b[31mReconnection failed. Please reconnect manually.\x1b[0m')
        onDisconnectedRef.current?.()
        return
      }

      reconnectAttempts++
      term.writeln(`\x1b[33mReconnecting (attempt ${reconnectAttempts}/${maxReconnectAttempts})...\x1b[0m`)

      await new Promise(resolve => setTimeout(resolve, 2000))

      try {
        const newWs = new WebSocket(wsUrl)
        
        newWs.onopen = () => {
          newWs.send(JSON.stringify({
            type: 'auth',
            tabId: id,
            ...config
          }))
        }

        newWs.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data)
            if (msg.type === 'reconnected' || msg.type === 'connected') {
              term.writeln('\x1b[32mReconnected!\x1b[0m')
              reconnectAttempts = 0
              wsRef.current = newWs
            } else if (msg.type === 'data') {
              term.write(msg.data)
            } else if (msg.type === 'error') {
              term.writeln(`\x1b[31mError: ${msg.message}\x1b[0m`)
            }
          } catch (err) {
            console.error('Error parsing message:', err)
          }
        }

        newWs.onerror = () => {
          tryReconnect(term, config, id)
        }

        newWs.onclose = () => {
          if (reconnectAttempts < maxReconnectAttempts) {
            tryReconnect(term, config, id)
          }
        }
      } catch (err) {
        tryReconnect(term, config, id)
      }
    }

    terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'data', data }))
      }
    })

    const handleResize = () => {
      if (fitAddonRef.current && terminalRef.current) {
        fitAddonRef.current.fit()
        const dims = fitAddonRef.current.proposeDimensions()
        if (ws.readyState === WebSocket.OPEN && dims) {
          ws.send(JSON.stringify({
            type: 'resize',
            cols: dims.cols,
            rows: dims.rows,
          }))
        }
      }
    }

    window.addEventListener('resize', handleResize)
    setTimeout(handleResize, 100)

    // Keep WebSocket alive with periodic pings
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }))
      }
    }, 25000) // Ping every 25 seconds

    return () => {
      clearInterval(pingInterval)
      window.removeEventListener('resize', handleResize)
      
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
      
      terminal.dispose()
      
      terminalRef.current = null
      fitAddonRef.current = null
      wsRef.current = null
    }
  }, [tabId, host, port, username, password, privateKey, passphrase])

  return (
    <div
      ref={containerRef}
      className="h-full w-full bg-[#1a1a2e] rounded-lg overflow-hidden"
      style={{ minHeight: '400px' }}
    />
  )
}