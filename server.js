// Custom server with WebSocket support for SSH connections
const { createServer } = require('http')
const { parse } = require('url')
const next = require('next')
const WebSocket = require('ws')
const ssh2 = require('ssh2')

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

// SSH connection sessions map (tabId -> { conn, stream, ws, lastActivity })
const sessions = new Map()

// Cleanup expired sessions every 30 seconds
setInterval(() => {
  const now = Date.now()
  for (const [tabId, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      console.log(`Session ${tabId} expired, closing SSH`)
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

  const wss = new WebSocket.Server({ noServer: true, clientTracking: true })

  // Next.js 13.1+ exposes getUpgradeHandler() so its HMR WebSocket
  // (/_next/webpack-hmr) works correctly with a custom server.
  // Without this, HMR upgrade requests have no handler and retry forever.
  const nextUpgradeHandler = await app.getUpgradeHandler()

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url)
    if (pathname === '/api/ssh') {
      wss.handleUpgrade(req, socket, head, (client) => {
        wss.emit('connection', client, req)
      })
    } else {
      // Let Next.js handle HMR and any other internal WebSocket upgrades
      nextUpgradeHandler(req, socket, head)
    }
  })

  // Heartbeat to keep connections alive - ping every 30 seconds
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

  wss.on('close', () => {
    clearInterval(heartbeatInterval)
  })

  wss.on('connection', (ws, req) => {
    let tabId = null

    // Mark connection as alive for heartbeat
    ws.isAlive = true
    ws.on('pong', () => {
      ws.isAlive = true
    })

    console.log('New WebSocket connection')

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())

        switch (msg.type) {
          case 'auth':
            // Each tab gets its own session — tabId is the unique key
            tabId = msg.tabId

            // Create new session
            console.log(`Creating new session for tab ${tabId} (${msg.username}@${msg.host})`)
            handleAuth(ws, msg, (session) => {
              sessions.set(tabId, session)
            })
            break

          case 'reconnect':
            // Client trying to reconnect to existing session
            tabId = msg.tabId
            const session = sessions.get(tabId)
            if (session && session.conn) {
              console.log(`Reconnecting to session ${tabId}`)
              attachToSession(ws, tabId, session)
            } else {
              ws.send(JSON.stringify({ 
                type: 'error', 
                message: 'Session expired. Please reconnect.' 
              }))
            }
            break

          case 'data':
            // Send keystrokes to SSH
            const dataSession = sessions.get(tabId)
            if (dataSession?.stream && dataSession.stream.writable) {
              dataSession.stream.write(msg.data)
              dataSession.lastActivity = Date.now()
            }
            break

          case 'resize':
            // Resize terminal
            const resizeSession = sessions.get(tabId)
            if (resizeSession?.stream) {
              resizeSession.stream.setWindow(msg.rows, msg.cols)
              resizeSession.lastActivity = Date.now()
            }
            break

          case 'ping':
            // Client ping for keepalive
            const pingSession = sessions.get(tabId)
            if (pingSession) {
              pingSession.lastActivity = Date.now()
            }
            break

          default:
            console.log('Unknown message type:', msg.type)
        }
      } catch (err) {
        console.error('Error processing message:', err)
      }
    })

    ws.on('close', () => {
      console.log(`WebSocket closed for ${tabId}`)
      
      // IMPORTANT: Don't close SSH immediately! Keep session alive for reconnection
      const session = sessions.get(tabId)
      if (session) {
        session.ws = null  // Detach WebSocket but keep SSH
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
  })
})

/**
 * Attach a new WebSocket to an existing SSH session.
 *
 * The data/close/stderr handlers set up in handleAuth already reference
 * session.ws, so just swapping that pointer is enough — no new listeners
 * needed, no listener accumulation across reconnects.
 *
 * The client is expected to send a 'resize' message immediately after
 * receiving 'reconnected', which will call stream.setWindow with the
 * actual current terminal dimensions.
 */
function attachToSession(ws, tabId, session) {
  session.ws = ws
  session.lastActivity = Date.now()

  // Replay buffered output so the terminal shows its current visual state
  if (session.outputBuffer) {
    ws.send(JSON.stringify({ type: 'replay', data: session.outputBuffer }))
  }

  // Signal reconnect — client will respond with a 'resize' message
  ws.send(JSON.stringify({ type: 'reconnected' }))

  console.log(`Reattached WebSocket to session ${tabId}`)
}

/**
 * Handle SSH authentication and connection
 */
function handleAuth(ws, msg, onReady) {
  const { host, port = 22, username, password, privateKey, passphrase, tabId } = msg

  if (!host || !username) {
    ws.send(JSON.stringify({ type: 'error', message: 'Host and username are required' }))
    return
  }

  if (!password && !privateKey) {
    ws.send(JSON.stringify({ type: 'error', message: 'Password or private key is required' }))
    return
  }

  const conn = new ssh2.Client()
  // Hoisted so conn.on('close') can reference the same session object
  // as the stream handlers set up inside conn.on('ready').
  let session = null

  const config = {
    host,
    port: parseInt(port) || 22,
    username,
    readyTimeout: 20000,
    keepaliveInterval: 30000,
  }

  // Add authentication method
  if (password) {
    config.password = password
  } else if (privateKey) {
    config.privateKey = privateKey
    if (passphrase) {
      config.passphrase = passphrase
    }
  }

  conn.on('ready', () => {
    console.log(`SSH connected to ${host}:${port}`)

    // Open an interactive shell
    conn.shell(
      { term: 'xterm-256color', cols: 80, rows: 24 },
      (err, stream) => {
        if (err) {
          ws.send(JSON.stringify({ type: 'error', message: `Shell error: ${err.message}` }))
          conn.end()
          return
        }

        console.log('Shell opened')

        // Assign to the hoisted let so conn.on('close') can see it too
        session = { conn, stream, ws, lastActivity: Date.now(), outputBuffer: '' }

        const appendToBuffer = (text) => {
          session.outputBuffer += text
          if (session.outputBuffer.length > MAX_OUTPUT_BUFFER) {
            // Trim from the front, keeping the most recent output
            session.outputBuffer = session.outputBuffer.slice(-MAX_OUTPUT_BUFFER)
          }
        }

        // Server-side output batching — accumulate SSH chunks for up to 10ms
        // before sending over WebSocket. SSH can produce hundreds of tiny
        // writes per second (e.g. ls output); batching them reduces WebSocket
        // frame overhead significantly without adding perceptible latency.
        let batchBuf = ''
        let batchTimer = null
        const flushBatch = () => {
          batchTimer = null
          if (!batchBuf) return
          const text = batchBuf
          batchBuf = ''
          if (session.ws?.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify({ type: 'data', data: text }))
          }
        }

        // Pipe SSH output to WebSocket and into the rolling buffer.
        // Use session.ws (not the closed-over ws) so reconnects automatically
        // route to the new WebSocket without adding a second handler.
        stream.on('data', (data) => {
          const text = data.toString('utf-8')
          appendToBuffer(text)
          batchBuf += text
          if (!batchTimer) batchTimer = setTimeout(flushBatch, 10)
        })

        stream.on('close', () => {
          console.log('Stream closed')
          if (batchTimer) { clearTimeout(batchTimer); batchTimer = null }
          if (session.ws?.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify({ type: 'disconnected' }))
          }
          sessions.delete(tabId)
          conn.end()
        })

        stream.stderr.on('data', (data) => {
          const text = data.toString('utf-8')
          appendToBuffer(text)
          batchBuf += text
          if (!batchTimer) batchTimer = setTimeout(flushBatch, 10)
        })

        // Notify client that connection is ready
        ws.send(JSON.stringify({ type: 'connected' }))

        onReady(session)
      }
    )
  })

  conn.on('error', (err) => {
    console.error('SSH connection error:', err)
    ws.send(JSON.stringify({ type: 'error', message: `SSH error: ${err.message}` }))
  })

  conn.on('close', () => {
    console.log('SSH connection closed')
    if (session?.ws?.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: 'disconnected' }))
    }
    sessions.delete(tabId)
  })

  // Initiate connection
  try {
    conn.connect(config)
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: `Connection failed: ${err.message}` }))
  }
}