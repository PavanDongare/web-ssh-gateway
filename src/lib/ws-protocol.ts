/**
 * ws-protocol.ts
 *
 * Lightweight binary frame protocol for SSH data transport.
 * Inspired by VibeTunnel's ws-v3.ts but simplified for our SSH use case.
 *
 * Frame layout:
 *   u8   type       — message type (see MsgType enum)
 *   u16  payloadLen — payload length in bytes (LE), max 65535
 *   u8[] payload    — raw bytes
 *
 * For control messages (auth, resize, ping, etc.) we keep JSON in the payload
 * for simplicity. Only the SSH data path (type=DATA) uses raw binary to avoid
 * UTF-8 corruption and JSON overhead.
 *
 * Total overhead per SSH data frame: 3 bytes (vs ~20+ bytes for JSON wrapping).
 */

// Use a plain const object instead of const enum — const enum doesn't work
// across module boundaries with Next.js (isolatedModules: true).
export const MsgType = {
  // Client → Server
  AUTH:      0x01,  // JSON payload: { tabId, mode?: 'ssh'|'local', host?, port?, username?, password?, privateKey?, passphrase? }
  RECONNECT: 0x02,  // JSON payload: { tabId }
  DATA:      0x03,  // Raw binary payload: keystrokes / paste data
  RESIZE:    0x04,  // JSON payload: { cols, rows }
  PING:      0x05,  // Empty payload

  // Server → Client
  CONNECTED:    0x10,  // Empty payload
  RECONNECTED:  0x11,  // Empty payload
  REPLAY:       0x12,  // Raw binary payload: buffered SSH output (fallback)
  SSH_DATA:     0x13,  // Raw binary payload: live SSH output
  ERROR:        0x14,  // JSON payload: { message }
  DISCONNECTED: 0x15,  // Empty payload
  SNAPSHOT:     0x16,  // JSON payload: TerminalSnapshot — exact terminal state on reconnect
} as const

export type MsgType = typeof MsgType[keyof typeof MsgType]

// ---------------------------------------------------------------------------
// Encoder (client-side, also used in tests)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

/** Encode a frame with a raw binary payload */
export function encodeFrame(type: MsgType, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const frame = new Uint8Array(3 + payload.length)
  const view  = new DataView(frame.buffer)
  view.setUint8(0, type)
  view.setUint16(1, payload.length, true /* LE */)
  frame.set(payload, 3)
  return frame
}

/** Encode a frame with a JSON payload */
export function encodeJsonFrame(type: MsgType, data: unknown): Uint8Array {
  return encodeFrame(type, encoder.encode(JSON.stringify(data)))
}

/** Encode a frame with a plain string payload */
export function encodeTextFrame(type: MsgType, text: string): Uint8Array {
  return encodeFrame(type, encoder.encode(text))
}

// ---------------------------------------------------------------------------
// Decoder (client-side)
// ---------------------------------------------------------------------------

export interface DecodedFrame {
  type: MsgType
  payload: Uint8Array
}

/** Decode a binary frame received from the server. Returns null on error. */
export function decodeFrame(buffer: ArrayBuffer): DecodedFrame | null {
  if (buffer.byteLength < 3) return null
  const view    = new DataView(buffer)
  const type    = view.getUint8(0) as MsgType
  const payLen  = view.getUint16(1, true)
  if (buffer.byteLength < 3 + payLen) return null
  const payload = new Uint8Array(buffer, 3, payLen)
  return { type, payload }
}

// Singleton decoder — avoids allocating a new TextDecoder on every frame
const _decoder = new TextDecoder()

/** Decode a JSON payload from a frame */
export function decodeJsonPayload<T>(payload: Uint8Array): T {
  return JSON.parse(_decoder.decode(payload)) as T
}

/** Decode a text payload from a frame */
export function decodeTextPayload(payload: Uint8Array): string {
  return _decoder.decode(payload)
}

// ---------------------------------------------------------------------------
// Snapshot types (Fix 7)
// Sent by server on reconnect — exact terminal state (cursor, colors, all cells)
// ---------------------------------------------------------------------------

/** A single terminal cell */
export interface SnapshotCell {
  ch: string    // character (may be multi-codepoint for wide chars)
  w:  number    // width (1 or 2 for wide chars, 0 for continuation)
  fg: number    // foreground color (-1 = default)
  bg: number    // background color (-1 = default)
  at: number    // attribute bitmask (see ATTR_* constants below)
}

export const ATTR_BOLD          = 0x01
export const ATTR_ITALIC        = 0x02
export const ATTR_UNDERLINE     = 0x04
export const ATTR_DIM           = 0x08
export const ATTR_INVERSE       = 0x10
export const ATTR_INVISIBLE     = 0x20
export const ATTR_STRIKETHROUGH = 0x40
export const ATTR_BLINK         = 0x80

/** Full terminal snapshot — sent on reconnect instead of raw replay */
export interface TerminalSnapshot {
  cols:      number           // terminal width
  rows:      number           // terminal height (visible)
  cursorX:   number           // cursor column (0-based)
  cursorY:   number           // cursor row relative to viewport (0-based)
  viewportY: number           // scroll offset from bottom (0 = at bottom)
  lines:     SnapshotCell[][] // visible rows, top to bottom
}
