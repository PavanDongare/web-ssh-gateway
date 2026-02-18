'use client'

/**
 * TerminalRenderer
 *
 * Pure terminal rendering component — faithful React port of vibetunnel's
 * terminal.ts (LitElement → React, same logic, same options).
 *
 * Responsibilities:
 *   - Load ghostty-web WASM (singleton)
 *   - Mount terminal canvas into the DOM
 *   - Fit terminal to container via ResizeObserver + requestAnimationFrame
 *   - Buffer pending output before terminal is ready
 *   - Track scroll position, show scroll-to-bottom button
 *   - Handle paste via hidden textarea
 *   - Expose write() and scrollToBottom() via ref
 *
 * NOT responsible for: WebSocket, SSH, reconnection logic.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { Ghostty, FitAddon, Terminal as GhosttyTerminal } from 'ghostty-web'
import { TERMINAL_FONT_FAMILY } from '@/utils/terminal-constants'
import { getThemeColors } from '@/utils/terminal-themes'
import { TerminalPreferencesManager } from '@/utils/terminal-preferences'

// ---------------------------------------------------------------------------
// ghostty-web singleton — identical to vibetunnel's ensureGhostty()
// ---------------------------------------------------------------------------
let ghosttyPromise: Promise<Ghostty> | null = null
function ensureGhostty(): Promise<Ghostty> {
  if (!ghosttyPromise) ghosttyPromise = Ghostty.load()
  return ghosttyPromise
}

// ---------------------------------------------------------------------------
// Public API exposed via ref
// ---------------------------------------------------------------------------
export interface TerminalRendererHandle {
  /** Write data to the terminal (buffered if not yet ready) */
  write(data: string, followCursor?: boolean): void
  /** Scroll the terminal to the bottom */
  scrollToBottom(): void
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface TerminalRendererProps {
  /** Called when the user types or pastes — send this to the SSH server */
  onData: (data: string) => void
  /** Called whenever the terminal is resized — send cols/rows to the SSH server */
  onResize: (cols: number, rows: number) => void
  /** Called once the terminal canvas is mounted and ready */
  onReady?: () => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
const TerminalRenderer = forwardRef<TerminalRendererHandle, TerminalRendererProps>(
  function TerminalRenderer({ onData, onResize, onReady }, ref) {
    const containerRef = useRef<HTMLDivElement>(null)
    const termRef      = useRef<GhosttyTerminal | null>(null)
    const fitRef       = useRef<FitAddon | null>(null)
    const roRef        = useRef<ResizeObserver | null>(null)

    // --- pending output (vibetunnel pattern: buffer before terminal ready) ---
    const pendingOutputRef      = useRef('')
    const pendingFollowCursorRef = useRef(true)

    // --- last known dimensions (skip redundant resize calls) ---
    const lastColsRef = useRef(0)
    const lastRowsRef = useRef(0)

    // --- mobile width locking (vibetunnel pattern) ---
    const isMobileRef                = useRef(false)
    const mobileWidthResizeCompleteRef = useRef(false)

    // --- scroll-to-bottom button ---
    const [showScrollBtn, setShowScrollBtn] = useState(false)
    const followCursorRef = useRef(true)

    // stable refs for callbacks (avoid re-running effect on every render)
    const onDataRef   = useRef(onData)
    const onResizeRef = useRef(onResize)
    const onReadyRef  = useRef(onReady)
    onDataRef.current   = onData
    onResizeRef.current = onResize
    onReadyRef.current  = onReady

    // -----------------------------------------------------------------------
    // Public API (matches vibetunnel's write() and scrollToBottom())
    // -----------------------------------------------------------------------
    useImperativeHandle(ref, () => ({
      write(data: string, followCursor = true) {
        if (!termRef.current) {
          // Buffer until terminal is ready — same as vibetunnel pendingOutput
          pendingOutputRef.current += data
          pendingFollowCursorRef.current = pendingFollowCursorRef.current && followCursor
          return
        }
        termRef.current.write(data, () => {
          if (followCursor && followCursorRef.current) {
            termRef.current?.scrollToBottom()
          }
        })
      },
      scrollToBottom() {
        termRef.current?.scrollToBottom()
      },
    }), [])

    // -----------------------------------------------------------------------
    // fitTerminal — exact port of vibetunnel's fitTerminal(source)
    // -----------------------------------------------------------------------
    const fitTerminal = useCallback((source = 'unknown') => {
      const fit  = fitRef.current
      const term = termRef.current
      if (!fit || !term) return

      const proposed = fit.proposeDimensions()
      if (!proposed) return

      const prefs   = TerminalPreferencesManager.getInstance()
      const maxCols = prefs.getMaxCols()

      let cols  = Math.max(20, Math.floor(proposed.cols))
      const rows = Math.max(6,  Math.floor(proposed.rows))

      // maxCols constraint (vibetunnel: computeConstrainedCols)
      if (maxCols > 0) cols = Math.min(cols, maxCols)

      // Mobile width lock — once set, don't change cols on mobile
      // (vibetunnel: isMobile && mobileWidthResizeComplete && lastCols)
      if (isMobileRef.current && mobileWidthResizeCompleteRef.current && lastColsRef.current) {
        cols = lastColsRef.current
      }

      // Skip if nothing actually changed
      if (cols === lastColsRef.current && rows === lastRowsRef.current) return

      lastColsRef.current = cols
      lastRowsRef.current = rows

      term.resize(cols, rows)
      // onResize fires via term.onResize below — no need to call it here
    }, [])

    // vibetunnel uses requestAnimationFrame for resize scheduling
    const requestFit = useCallback((source: string) => {
      requestAnimationFrame(() => fitTerminal(source))
    }, [fitTerminal])

    // -----------------------------------------------------------------------
    // Main effect — init terminal once, clean up on unmount
    // -----------------------------------------------------------------------
    useEffect(() => {
      if (!containerRef.current) return

      let aborted = false  // StrictMode double-mount guard

      const init = async () => {
        const ghostty = await ensureGhostty()
        if (aborted || !containerRef.current) return

        const prefs = TerminalPreferencesManager.getInstance()

        // --- Create terminal (exact vibetunnel constructor options) ---
        const term = new GhosttyTerminal({
          cols: 80,
          rows: 24,
          fontSize:            prefs.getFontSize(),
          fontFamily:          TERMINAL_FONT_FAMILY,
          theme:               getThemeColors(prefs.getTheme()),
          cursorBlink:         true,
          smoothScrollDuration: 120,
          ghostty,
        })

        const fit = new FitAddon()
        term.loadAddon(fit)

        // Clear container before mounting (vibetunnel: container.innerHTML = '')
        containerRef.current.innerHTML = ''
        term.open(containerRef.current)

        termRef.current = term
        fitRef.current  = fit

        // --- Flush pending output (vibetunnel pattern) ---
        if (pendingOutputRef.current) {
          const pending      = pendingOutputRef.current
          const followCursor = pendingFollowCursorRef.current
          pendingOutputRef.current       = ''
          pendingFollowCursorRef.current = true
          term.write(pending, () => {
            if (followCursor && followCursorRef.current) term.scrollToBottom()
          })
        }

        // --- onData: user typed → parent sends to SSH ---
        term.onData((text) => {
          onDataRef.current(text)
        })

        // --- onResize: terminal resized → parent sends to SSH ---
        term.onResize(({ cols, rows }) => {
          lastColsRef.current = cols
          lastRowsRef.current = rows
          if (isMobileRef.current) mobileWidthResizeCompleteRef.current = true
          onResizeRef.current(cols, rows)
        })

        // --- onScroll: track follow-cursor (vibetunnel pattern) ---
        term.onScroll(() => {
          const vY = term.getViewportY?.() ?? 0
          const atBottom = vY <= 0.5
          followCursorRef.current = atBottom
          setShowScrollBtn(!atBottom)
        })

        // --- ResizeObserver (vibetunnel uses this, not window.resize) ---
        roRef.current = new ResizeObserver(() => {
          isMobileRef.current = window.innerWidth < 768
          requestFit('resize-observer')
        })
        roRef.current.observe(containerRef.current!)

        // --- Initial fit (vibetunnel: requestResize('initial')) ---
        isMobileRef.current = window.innerWidth < 768
        requestFit('initial')

        onReadyRef.current?.()
      }

      init()

      return () => {
        aborted = true
        roRef.current?.disconnect()
        roRef.current = null
        termRef.current?.dispose()
        termRef.current = null
        fitRef.current  = null
      }
    }, [requestFit])

    // -----------------------------------------------------------------------
    // Scroll button handler
    // -----------------------------------------------------------------------
    const handleScrollToBottom = () => {
      followCursorRef.current = true
      setShowScrollBtn(false)
      termRef.current?.scrollToBottom()
    }

    // -----------------------------------------------------------------------
    // Paste handler — forward clipboard text to SSH via onData
    // (vibetunnel: hidden textarea + paste event)
    // -----------------------------------------------------------------------
    const handlePaste = (e: React.ClipboardEvent) => {
      // Images / files — ignore
      if (e.clipboardData.files.length > 0) return
      const text = e.clipboardData.getData('text/plain')
      if (!text) return
      e.preventDefault()
      e.stopPropagation()
      onDataRef.current(text)
    }

    const bgColor = getThemeColors(
      TerminalPreferencesManager.getInstance().getTheme()
    ).background ?? '#282A36'

    // -----------------------------------------------------------------------
    // Render — matches vibetunnel's render() structure
    // -----------------------------------------------------------------------
    return (
      <div
        style={{ position: 'absolute', inset: 0, backgroundColor: bgColor }}
        onPaste={handlePaste}
      >
        {/* Hidden textarea for native paste capture (vibetunnel pattern) */}
        <textarea
          aria-hidden="true"
          tabIndex={-1}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          style={{
            position: 'absolute',
            left: -9999,
            top: 0,
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: 'none',
          }}
          onPaste={handlePaste}
        />

        {/* Terminal canvas mount point */}
        <div
          ref={containerRef}
          id="terminal-container"
          style={{
            width:    '100%',
            height:   '100%',
            overflow: 'hidden',
            fontFamily:           TERMINAL_FONT_FAMILY,
            touchAction:          'manipulation',
            WebkitUserSelect:     'text',
            userSelect:           'text',
          }}
        />

        {/* Scroll-to-bottom button (vibetunnel pattern) */}
        {showScrollBtn && (
          <button
            type="button"
            onClick={handleScrollToBottom}
            style={{
              position:     'absolute',
              right:        12,
              bottom:       12,
              zIndex:       20,
              background:   'rgba(0,0,0,0.55)',
              color:        '#fff',
              border:       '1px solid rgba(255,255,255,0.18)',
              borderRadius: 10,
              padding:      '6px 10px',
              fontFamily:   TERMINAL_FONT_FAMILY,
              fontSize:     12,
              cursor:       'pointer',
            }}
          >
            ↓ Scroll to bottom
          </button>
        )}
      </div>
    )
  }
)

export default TerminalRenderer
