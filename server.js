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

app.prepare().then(() => {
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

  // WebSocket server for terminal sessions
  const wss = new WebSocket.Server({ 
    server, 
    path: '/api/ssh',
    clientTracking: true 
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
            // Use host+username as session key (not tabId) for reconnection
            const sessionKey = `${msg.username}@${msg.host}`
            tabId = sessionKey
            
            // Check if session already exists
            const existingSession = sessions.get(sessionKey)
            if (existingSession && existingSession.conn) {
              console.log(`Reconnecting to existing session ${sessionKey}`)
              // Reattach to existing session
              attachToSession(ws, sessionKey, existingSession)
            } else {
              // Create new session
              console.log(`Creating new session for ${sessionKey}`)
              handleAuth(ws, msg, (conn, stream) => {
                const session = { 
                  conn, 
                  stream, 
                  ws, 
                  lastActivity: Date.now() 
                }
                sessions.set(sessionKey, session)
              })
            }
            break

          case 'reconnect':
            // Client trying to reconnect to existing session
            tabId = msg.tabId
            const session = sessions.get(tabId)
            if (session && session.conn) {
              console.log(`Reconnecting to session ${tabId}`)
              session.ws = ws  // Update WebSocket reference
              session.lastActivity = Date.now()
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
 * Attach WebSocket to existing SSH session
 */
function attachToSession(ws, tabId, session) {
  const { conn, stream } = session
  
  // Update session with new WebSocket
  session.ws = ws
  session.lastActivity = Date.now()

  // Send reconnected message
  ws.send(JSON.stringify({ type: 'reconnected' }))

  // Pipe SSH output to new WebSocket
  const dataHandler = (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data: data.toString('utf-8') }))
    }
  }
  
  stream.on('data', dataHandler)

  // Handle stream close
  stream.on('close', () => {
    ws.send(JSON.stringify({ type: 'disconnected' }))
    sessions.delete(tabId)
  })

  // Handle stderr
  stream.stderr.on('data', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data: data.toString('utf-8') }))
    }
  })

  // Send initial resize
  stream.setWindow(80, 24)
  
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

        // Pipe SSH output to WebSocket
        stream.on('data', (data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'data', data: data.toString('utf-8') }))
          }
        })

        stream.on('close', () => {
          console.log('Stream closed')
          ws.send(JSON.stringify({ type: 'disconnected' }))
          if (tabId) {
            sessions.delete(tabId)
          }
          conn.end()
        })

        stream.stderr.on('data', (data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'data', data: data.toString('utf-8') }))
          }
        })

        // Notify client that connection is ready
        ws.send(JSON.stringify({ type: 'connected' }))

        onReady(conn, stream)
      }
    )
  })

  conn.on('error', (err) => {
    console.error('SSH connection error:', err)
    ws.send(JSON.stringify({ type: 'error', message: `SSH error: ${err.message}` }))
  })

  conn.on('close', () => {
    console.log('SSH connection closed')
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'disconnected' }))
    }
    if (tabId) {
      sessions.delete(tabId)
    }
  })

  // Initiate connection
  try {
    conn.connect(config)
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: `Connection failed: ${err.message}` }))
  }
}