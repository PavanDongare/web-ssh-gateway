# WebSSH Gateway — Project Overview

## Goal

A self-hosted, browser-based SSH client inspired by Termius. No native app, no extensions — just open a browser tab and connect to any SSH server. Built to be fast, clean, and usable as a daily driver for developers who manage remote servers.

---

## Who It's For

Developers and sysadmins who want:
- SSH access from any machine without installing a client
- A single self-hosted tool they control (vs. cloud-based Termius)
- Multiple simultaneous SSH sessions in one browser window

---

## Core Features

**Multi-tab sessions** — Open multiple SSH connections simultaneously, each in its own tab, switchable instantly.

**Saved connections** — Previously used servers are saved and shown at the top for one-click reconnect.

**Session persistence** — Closing a browser tab does not kill the SSH session. The shell stays alive on the server for 5 minutes, so reconnecting picks up right where you left off.

**Password and SSH key auth** — Connect with a password or paste a private key (with optional passphrase).

**Auto-reconnect** — If the WebSocket drops, the client automatically attempts to reconnect up to 5 times before giving up.

**Theme system** — 6 built-in terminal color themes: Dracula (default), Nord, VS Code Dark, Dark, Light, and Auto (follows system preference).

**User preferences** — Font size, theme, and max column width are persisted across sessions via localStorage.

**Responsive** — Works on mobile with touch-friendly input and a mobile-adjusted font size.

**Scroll tracking** — Terminal follows the cursor automatically. When you scroll up to review history, a "Scroll to bottom" button appears.

---

## High-Level Architecture

```
Browser
  └── React UI (tabs, saved connections, modals)
        └── Terminal component (ghostty-web WASM renderer)
              └── WebSocket
                    └── Node.js server
                          └── SSH connection (ssh2)
                                └── Remote server
```

The browser never talks to SSH directly. All SSH traffic goes through the Node.js server, which acts as a bridge between the WebSocket (browser) and the SSH protocol (remote server).

---

## Tech Stack

| | |
|---|---|
| **Frontend framework** | Next.js + React |
| **Styling** | Tailwind CSS |
| **Terminal renderer** | ghostty-web (WASM — same engine as the Ghostty native app) |
| **Transport** | WebSocket |
| **SSH** | ssh2 (Node.js) |
| **Language** | TypeScript |
| **Runtime** | Node.js |

---

## What Makes It Feel Like Termius

- Tab bar for multiple simultaneous sessions
- Saved connections bar for quick reconnect
- Sessions survive tab close (reconnect without re-authenticating)
- High-fidelity terminal rendering (256 colors, true color, smooth scrolling)
- Multiple color themes with user preference persistence
- Clean, dark-first UI
