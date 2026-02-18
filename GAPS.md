# Gaps vs VibeTunnel

Things to fix later, ordered by impact.

---

## 1. Terminal State Restoration — BIGGEST GAP

VibeTunnel runs a **server-side Ghostty WASM instance** per session. On reconnect it sends a `SNAPSHOT_VT` frame — browser renders the exact current terminal state instantly (cursor, colors, scroll, everything).

Our replay sends raw accumulated text. xterm.js re-runs all ANSI sequences from scratch. If `vim` or `htop` was open, the replay is mangled.

**Fix:** Add a headless terminal emulator on the server.
- Option A: `xterm-headless` (from `@xterm/xterm` — same lib, no DOM)
- Option B: `node-pty` with a VT parser

Effort: Days. Highest payoff.

---

## 2. Page Refresh Loses Session

`tabId` is generated fresh on every component mount. Refresh the page → new tabId → can't reconnect to existing SSH session even if it's still alive on the server.

**Fix:** Persist `tabId` in `sessionStorage`.
```ts
// In Terminal.tsx or parent:
const tabId = sessionStorage.getItem('tabId') ?? crypto.randomUUID()
sessionStorage.setItem('tabId', tabId)
```
Effort: 5 min.

---

## 3. Fixed Reconnect Delay + No Manual Retry Button

Fixed 2s × 5 attempts. After 5 failures, user is stuck with no way to retry.

**Fix:** Exponential backoff + a "Reconnect" button shown after max attempts.
```
1s → 2s → 4s → 8s → 16s → show button
```
Effort: 15 min.

---

## 4. Protocol: JSON vs Binary

Every keystroke: `{"type":"data","data":"a"}` = 22 bytes for 1 character.
VibeTunnel uses binary frames with a magic byte header — ~9 bytes, no parse cost.

Not urgent for SSH use, but adds up during high-throughput output.

**Fix:** Define a simple binary frame format, or at minimum strip JSON for `data` messages.
Effort: 1–2 days (affects both client and server).

---

## 5. No Multiplexing — One WebSocket Per Session

VibeTunnel uses one WebSocket for all sessions (multiplexed by sessionId in frame header). Browser has a per-origin WebSocket connection limit (~6).

**Fix:** Multiplex sessions over a single WebSocket with a frame header containing sessionId.
Effort: 2–3 days.

---

## 6. Binary-Unsafe Buffer

```js
const text = data.toString('utf-8')  // corrupts binary data
```

File transfers (`sz`/`rz`), iTerm2 image protocol, etc. will be corrupted.

**Fix:** Keep data as `Buffer`, send as binary WebSocket frames (`ws.send(buffer)`), receive as `ArrayBuffer` on client.
Effort: 1 day.

---

## 7. No Input Backpressure

Large paste → `stream.write(msg.data)` with no check on drain. Can silently drop data if SSH write buffer fills.

**Fix:**
```js
if (!stream.write(msg.data)) {
  ws.pause()
  stream.once('drain', () => ws.resume())
}
```
Effort: 20 min.

---

## Priority Order

| # | Gap | Effort | Impact |
|---|-----|--------|--------|
| 1 | `sessionStorage` tabId | 5 min | High |
| 2 | Exponential backoff + retry button | 15 min | Medium |
| 3 | Input backpressure | 20 min | Low |
| 4 | Binary-safe buffer | 1 day | Low (unless file transfer needed) |
| 5 | Binary protocol | 1–2 days | Medium |
| 6 | WS multiplexing | 2–3 days | Medium |
| 7 | Server-side terminal snapshot | Days | Very High |
