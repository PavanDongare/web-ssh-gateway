# Gaps vs VibeTunnel

Things to fix later, ordered by impact.

---

## ✅ 1. Terminal State Restoration — FIXED

~~VibeTunnel runs a **server-side Ghostty WASM instance** per session. On reconnect it sends a `SNAPSHOT_VT` frame — browser renders the exact current terminal state instantly (cursor, colors, scroll, everything).~~

**Done:** Server now runs a headless `@xterm/xterm` Terminal per SSH session. On reconnect it serializes the exact terminal state (cursor position, all cell colors/attributes, TUI app state) into a `SNAPSHOT` binary frame. The client reconstructs it as VT100 escape sequences and feeds them to Ghostty — vim/htop/tmux all render correctly on reconnect.

Files changed: `server.js`, `src/components/Terminal.tsx`, `src/lib/ws-protocol.ts`

---

## ✅ 2. Page Refresh Loses Session — FIXED

~~`tabId` is generated fresh on every component mount. Refresh the page → new tabId → can't reconnect to existing SSH session even if it's still alive on the server.~~

**Done:** `tabId` is now persisted in `sessionStorage`. Page refresh reuses the same tabId and reconnects to the live SSH session.

Files changed: `src/components/Terminal.tsx`

---

## ✅ 3. Fixed Reconnect Delay + No Manual Retry Button — FIXED

~~Fixed 2s × 5 attempts. After 5 failures, user is stuck with no way to retry.~~

**Done:** Exponential backoff (1s → 2s → 4s → 8s → 16s → 30s cap). After 5 failed attempts a "↺ Reconnect" button appears with a note that the server session may still be alive.

Files changed: `src/components/Terminal.tsx`

---

## ✅ 4. Binary-Unsafe Buffer — FIXED

~~`const text = data.toString('utf-8')` corrupts binary data~~

**Done:** SSH output is kept as raw `Buffer` throughout the server pipeline. WebSocket sends binary frames. Client receives `ArrayBuffer` and decodes with `TextDecoder` in streaming mode (preserving multi-byte UTF-8 sequences across chunk boundaries).

Files changed: `server.js`, `src/components/Terminal.tsx`

---

## ✅ 5. Protocol: JSON vs Binary — FIXED

~~Every keystroke: `{"type":"data","data":"a"}` = 22 bytes for 1 character.~~

**Done:** Binary frame protocol implemented in `src/lib/ws-protocol.ts`. Frame layout: `u8 type | u16 payloadLen | u8[] payload`. SSH data frames carry raw bytes with 3-byte overhead (vs 20+ bytes for JSON). Control messages (auth, resize) still use JSON payload for simplicity.

Files changed: `src/lib/ws-protocol.ts`, `server.js`, `src/components/Terminal.tsx`

---

## ✅ 6. No Input Backpressure — FIXED

~~Large paste → `stream.write(msg.data)` with no check on drain. Can silently drop data if SSH write buffer fills.~~

**Done:** `stream.write()` return value is checked. If the SSH write buffer is full, the WebSocket is paused and resumed on `drain`.

Files changed: `server.js`

---

## ✅ 7. disableStdin + Theme Observer — FIXED (bonus fixes from VibeTunnel study)

**Done:**
- `disableStdin: true` on GhosttyTerminal — all input routed exclusively through `onData` callback, matching VibeTunnel exactly.
- Live auto-theme via `MutationObserver` on `<html data-theme>` + `prefers-color-scheme` media query — theme updates instantly when user toggles dark/light mode.

Files changed: `src/components/TerminalRenderer.tsx`

---

## 🔲 8. No Multiplexing — One WebSocket Per Session

VibeTunnel uses one WebSocket for all sessions (multiplexed by sessionId in frame header). Browser has a per-origin WebSocket connection limit (~6).

**Fix:** Multiplex sessions over a single WebSocket with a frame header containing sessionId.

The binary protocol (`src/lib/ws-protocol.ts`) is already designed to support this — just needs a `sessionId` field added to the frame header and a router on both ends.

Effort: 2–3 days. Impact: Medium (only matters when user has 6+ concurrent SSH tabs).

---

## Priority Order (updated)

| # | Gap | Status | Effort | Impact |
|---|-----|--------|--------|--------|
| 1 | `sessionStorage` tabId | ✅ Done | 5 min | High |
| 2 | Exponential backoff + retry button | ✅ Done | 15 min | Medium |
| 3 | Input backpressure | ✅ Done | 20 min | Low |
| 4 | Binary-safe buffer | ✅ Done | 1 day | Low |
| 5 | Binary protocol | ✅ Done | 1–2 days | Medium |
| 6 | Server-side terminal snapshot | ✅ Done | Days | Very High |
| 7 | disableStdin + live theme | ✅ Done | Hours | Medium |
| 8 | WS multiplexing | 🔲 Todo | 2–3 days | Medium |
