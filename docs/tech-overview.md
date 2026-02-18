# Technical Overview

## System Architecture

```
                        ┌─────────────────────────────┐
                        │          Browser            │
                        │                             │
                        │  ┌────────┐  ┌──────────┐  │
                        │  │  Tab   │  │  Tab     │  │
                        │  │ Bar    │  │ (active) │  │
                        │  └────────┘  └──────────┘  │
                        │       ┌──────────────┐      │
                        │       │   Terminal   │      │
                        │       │ ghostty-web  │      │
                        │       │    (WASM)    │      │
                        │       └──────────────┘      │
                        └──────────────┬──────────────┘
                                       │
                              WebSocket (JSON)
                              ws:// or wss://
                                       │
                        ┌──────────────▼──────────────┐
                        │       Node.js Server        │
                        │                             │
                        │  ┌──────────────────────┐  │
                        │  │   WebSocket Server   │  │
                        │  └──────────┬───────────┘  │
                        │             │               │
                        │  ┌──────────▼───────────┐  │
                        │  │   SSH Session Map    │  │
                        │  │  user@host-a ──► ··· │  │
                        │  │  user@host-b ──► ··· │  │
                        │  └──────────┬───────────┘  │
                        │             │               │
                        │  ┌──────────▼───────────┐  │
                        │  │     ssh2 Client      │  │
                        │  └──────────────────────┘  │
                        └──────┬──────────┬───────────┘
                               │          │
                        SSH (port 22)  SSH (port 22)
                               │          │
                    ┌──────────▼──┐  ┌────▼────────┐
                    │  Server A   │  │  Server B   │
                    └─────────────┘  └─────────────┘
```

---

## Connection Flow

```
  Browser                   Node.js Server              Remote Server
     │                            │                            │
     │── Open WebSocket ─────────►│                            │
     │                            │                            │
     │── { type: "auth"           │                            │
     │    host, user, password }─►│                            │
     │                            │── TCP connect ────────────►│
     │                            │── SSH handshake ──────────►│
     │                            │── Authenticate ───────────►│
     │                            │◄─ Auth accepted ───────────│
     │                            │── Open shell ─────────────►│
     │                            │◄─ Shell ready ─────────────│
     │◄─ { type: "connected" } ───│                            │
     │                            │                            │
     │    ╔═══════════════════════╪════════════════════════╗   │
     │    ║         Live session  │                        ║   │
     │    ║                       │                        ║   │
     │─── ║─ { type: "data" } ───►│── write to stdin ─────►║   │
     │    ║                       │◄─ stdout output ───────║   │
     │◄── ║─ { type: "data" } ────│                        ║   │
     │    ╚═══════════════════════╪════════════════════════╝   │
     │                            │                            │
     │── WebSocket closes         │                            │
     │   (tab closed)             │                            │
     │                            │  SSH stays alive (5 min)   │
     │                            │                            │
     │── Reconnect WebSocket ────►│                            │
     │◄─ { type: "reconnected" } ─│                            │
     │                            │                            │
```

---

## Frontend Layout

```
┌──────────────────────────────────────────────────────────┐
│  WebSSH Gateway                          + New Connection │  ← Header
├──────────────────────────────────────────────────────────┤
│  Saved:  [user@host-a ×]  [user@host-b ×]  [user@host-c ×]│  ← Saved connections
├────────────────┬────────────────┬────────────────────────┤
│ user@host-a    │ user@host-b    │                        │  ← Tab bar
├────────────────┴────────────────┴────────────────────────┤
│                                                          │
│                                                          │
│   $ █                                                    │  ← Terminal
│                                                          │   (ghostty-web canvas)
│                                                          │
│                                                          │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

## Session Persistence

```
  Tab open                                          Tab closed
      │                                                 │
      ▼                                                 ▼
  ┌────────┐   auth OK   ┌───────────┐   WS drops  ┌──────────┐
  │        │────────────►│           │────────────►│          │
  │Connecting│           │ Connected │             │ Detached │
  │        │◄────────────│           │◄────────────│          │
  └────────┘   error     └───────────┘  reconnect  └────┬─────┘
                               │        (< 5 min)       │
                               │ shell exits             │ 5 min
                               ▼         or timeout      ▼
                         ┌───────────┐             ┌──────────┐
                         │Terminated │             │ Expired  │
                         └───────────┘             └──────────┘

  Note: SSH session stays alive during "Detached" — the shell
        keeps running, commands keep executing.
```

---

## Data Flow — Keystroke to Shell and Back

```
  BROWSER                          SERVER                       REMOTE

  ┌─────────────┐                                          ┌──────────────┐
  │  User types │                                          │ Shell process│
  │     'ls'    │                                          └──────┬───────┘
  └──────┬──────┘                                                 │
         │ onData()                                               │
         ▼                                                        │
  ┌─────────────┐   WebSocket    ┌──────────┐   SSH stream       │
  │  ghostty-web│───{ data:'l' }►│ Node.js  │──── stdin ────────►│
  │  terminal   │───{ data:'s' }►│ session  │◄─── stdout ────────│
  │             │───{ data:'\n'}►│ manager  │                    │
  │             │                └──────────┘                    │
  │             │◄──{ data: output (file list) }─────────────────┘
  │  renders    │
  │  output     │
  └─────────────┘
```

---

## WebSocket Protocol

```
  Browser ──────────────────────────────────────────► Server

    { type: "auth",      host, port, username,
                         password | privateKey }      connect + authenticate
    { type: "data",      data: string }               keystroke / paste
    { type: "resize",    cols, rows }                 terminal resized
    { type: "ping" }                                  keepalive every 25s
    { type: "reconnect", tabId }                      rejoin existing session


  Server ───────────────────────────────────────────► Browser

    { type: "connected" }                             shell is ready
    { type: "reconnected" }                           rejoined session
    { type: "data",      data: string }               terminal output
    { type: "error",     message: string }            something went wrong
    { type: "disconnected" }                          session ended
```

---

## Tech Stack

```
  ┌─────────────────────────────────────────────────────┐
  │                     Browser                         │
  │                                                     │
  │   Next.js 16 ──► React 19 ──► Tailwind CSS 4       │
  │                      │                              │
  │               ghostty-web 0.4                       │
  │           (WASM terminal renderer)                  │
  └─────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────┐
  │                   Node.js Server                    │
  │                                                     │
  │   ws (WebSocket) ──── ssh2 (SSH client)             │
  │         │                    │                      │
  │         └──── session map ───┘                      │
  └─────────────────────────────────────────────────────┘

  Language: TypeScript 5
  Runtime:  Node.js 20+
```
