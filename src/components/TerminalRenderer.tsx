'use client'

/**
 * TerminalRenderer
 *
 * Pure terminal rendering component — faithful React port of vibetunnel's
 * terminal.ts (LitElement → React, same logic, same options).
 *
 * Key insight from VibeTunnel source:
 *   - disableStdin: false  → Terminal's built-in InputHandler captures keydown
 *   - term.onData()        → fires when user types, forward to SSH server
 *   - No manual InputHandler needed — Terminal.open() creates one automatically
 *
 * Responsibilities:
 *   - Load ghostty-web WASM (singleton)
 *   - Mount terminal canvas into the DOM
 *   - Fit terminal to container via ResizeObserver + requestAnimationFrame
 *   - Buffer pending output before terminal is ready
 *   - Track scroll position, show scroll-to-bottom button
 *   - Handle paste via hidden textarea
 *   - Expose write() and scrollToBottom() via ref
 *   - Live auto-theme via MutationObserver on <html data-theme>
 *
 * NOT responsible for: WebSocket, SSH, reconnection logic.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Ghostty, FitAddon, Terminal as GhosttyTerminal } from 'ghostty-web'
import { TERMINAL_FONT_FAMILY } from '@/utils/terminal-constants'
import { getThemeColors } from '@/utils/terminal-themes'
import { TerminalPreferencesManager } from '@/utils/terminal-preferences'
import VoiceInput from './VoiceInput'

// ---------------------------------------------------------------------------
// Module-level singletons — created once, never re-created
// ---------------------------------------------------------------------------
let ghosttyPromise: Promise<Ghostty> | null = null
function ensureGhostty(): Promise<Ghostty> {
  if (!ghosttyPromise) ghosttyPromise = Ghostty.load()
  return ghosttyPromise
}

// Cache the preferences singleton at module level — avoids getInstance() call
// on every render and every fitTerminal() invocation.
const prefs = TerminalPreferencesManager.getInstance()

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
  /** Called with transcribed voice text — same path as keyboard input */
  onTranscript?: (text: string) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
const TerminalRenderer = forwardRef<TerminalRendererHandle, TerminalRendererProps>(
  function TerminalRenderer({ onData, onResize, onReady, onTranscript }, ref) {
    const containerRef = useRef<HTMLDivElement>(null)
    const termRef      = useRef<GhosttyTerminal | null>(null)
    const fitRef       = useRef<FitAddon | null>(null)
    const roRef        = useRef<ResizeObserver | null>(null)

    // --- pending output (vibetunnel pattern: buffer before terminal ready) ---
    const pendingOutputRef       = useRef('')
    const pendingFollowCursorRef = useRef(true)

    // --- last known dimensions (skip redundant resize calls) ---
    const lastColsRef = useRef(0)
    const lastRowsRef = useRef(0)

    // --- mobile width locking (vibetunnel pattern) ---
    const isMobileRef                  = useRef(false)
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

      const maxCols = prefs.getMaxCols()

      let cols  = Math.max(20, Math.floor(proposed.cols))
      const rows = Math.max(6,  Math.floor(proposed.rows))

      if (maxCols > 0) cols = Math.min(cols, maxCols)

      if (isMobileRef.current && mobileWidthResizeCompleteRef.current && lastColsRef.current) {
        cols = lastColsRef.current
      }

      if (cols === lastColsRef.current && rows === lastRowsRef.current) return

      lastColsRef.current = cols
      lastRowsRef.current = rows

      term.resize(cols, rows)
    }, [])

    const requestFit = useCallback((source: string) => {
      requestAnimationFrame(() => fitTerminal(source))
    }, [fitTerminal])

    // -----------------------------------------------------------------------
    // Main effect — init terminal once, clean up on unmount
    // -----------------------------------------------------------------------
    useEffect(() => {
      if (!containerRef.current) return

      let aborted = false

      const init = async () => {
        const ghostty = await ensureGhostty()
        if (aborted || !containerRef.current) return

        // Guard: don't double-init if StrictMode already ran this
        if (termRef.current) return

        // disableStdin: false — Terminal's built-in InputHandler captures keydown
        // and fires term.onData() with properly encoded VT sequences.
        // This is the same approach VibeTunnel uses.
        const term = new GhosttyTerminal({
          cols:                 80,
          rows:                 24,
          fontSize:             prefs.getFontSize(),
          fontFamily:           TERMINAL_FONT_FAMILY,
          theme:                getThemeColors(prefs.getTheme()),
          cursorBlink:          true,
          smoothScrollDuration: 120,
          disableStdin:         false,
          ghostty,
        })

        const fit = new FitAddon()
        term.loadAddon(fit)

        containerRef.current.innerHTML = ''
        term.open(containerRef.current)

        termRef.current = term
        fitRef.current  = fit

        // Flush pending output
        if (pendingOutputRef.current) {
          const pending      = pendingOutputRef.current
          const followCursor = pendingFollowCursorRef.current
          pendingOutputRef.current       = ''
          pendingFollowCursorRef.current = true
          term.write(pending, () => {
            if (followCursor && followCursorRef.current) term.scrollToBottom()
          })
        }

        // term.onData fires when user types (via built-in InputHandler)
        // Forward to SSH server via WebSocket
        term.onData((text) => {
          onDataRef.current(text)
        })

        // term.onResize fires after terminal.resize() — send new dims to SSH
        term.onResize(({ cols, rows }) => {
          lastColsRef.current = cols
          lastRowsRef.current = rows
          if (isMobileRef.current) mobileWidthResizeCompleteRef.current = true
          onResizeRef.current(cols, rows)
        })

        // Track scroll position for follow-cursor button
        term.onScroll(() => {
          const vY = term.getViewportY?.() ?? 0
          const atBottom = vY <= 0.5
          followCursorRef.current = atBottom
          setShowScrollBtn(!atBottom)
        })

        // ResizeObserver — vibetunnel uses this, not window.resize
        roRef.current = new ResizeObserver(() => {
          isMobileRef.current = window.innerWidth < 768
          requestFit('resize-observer')
        })
        roRef.current.observe(containerRef.current!)

        isMobileRef.current = window.innerWidth < 768
        requestFit('initial')

        // Live auto-theme: watch <html data-theme> for OS/user theme changes
        const themeObserver = new MutationObserver(() => {
          if (prefs.getTheme() === 'auto') {
            term.options.theme = getThemeColors('auto')
          }
        })
        themeObserver.observe(document.documentElement, {
          attributes:      true,
          attributeFilter: ['data-theme', 'class'],
        })

        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
        const handleMediaChange = () => {
          if (prefs.getTheme() === 'auto') {
            term.options.theme = getThemeColors('auto')
          }
        }
        mediaQuery.addEventListener('change', handleMediaChange)

        onReadyRef.current?.()

        // Stash cleanup refs on the term object
        ;(term as unknown as { _themeObserver: MutationObserver })._themeObserver = themeObserver
        ;(term as unknown as { _mediaQuery: MediaQueryList })._mediaQuery = mediaQuery
        ;(term as unknown as { _handleMediaChange: () => void })._handleMediaChange = handleMediaChange
      }

      init()

      return () => {
        aborted = true
        roRef.current?.disconnect()
        roRef.current = null

        const t = termRef.current as unknown as {
          _themeObserver?: MutationObserver
          _mediaQuery?: MediaQueryList
          _handleMediaChange?: () => void
        } | null
        t?._themeObserver?.disconnect()
        if (t?._mediaQuery && t?._handleMediaChange) {
          t._mediaQuery.removeEventListener('change', t._handleMediaChange)
        }

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
    // Terminal's built-in paste handler fires term.onData() for bracketed paste,
    // but we also handle React-level paste events for the outer wrapper div.
    // -----------------------------------------------------------------------
    const handlePaste = (e: React.ClipboardEvent) => {
      if (e.clipboardData.files.length > 0) return
      const text = e.clipboardData.getData('text/plain')
      if (!text) return
      e.preventDefault()
      e.stopPropagation()
      onDataRef.current(text)
    }

    // useMemo — bgColor only changes when theme preference changes (rare).
    // Avoids re-computing theme colors on every render (e.g. scroll button toggle).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const bgColor = useMemo(
      () => getThemeColors(prefs.getTheme()).background ?? '#282A36',
      [] // prefs is a module-level singleton; theme changes are applied via term.options.theme
    )

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------
    return (
      <div
        style={{
          position:        'absolute',
          inset:           0,
          backgroundColor: bgColor,
          padding:         'clamp(4px, 1.5vw, 10px) clamp(4px, 2vw, 14px)',
          boxSizing:       'border-box',
        }}
        onPaste={handlePaste}
      >
        {/* Terminal canvas mount point */}
        <div
          ref={containerRef}
          id="terminal-container"
          style={{
            width:             '100%',
            height:            '100%',
            overflow:          'hidden',
            fontFamily:        TERMINAL_FONT_FAMILY,
            touchAction:       'manipulation',
            WebkitUserSelect:  'text',
            userSelect:        'text',
          }}
        />

        {/* Voice input button */}
        {onTranscript && (
          <VoiceInput onTranscript={onTranscript} />
        )}

        {/* Scroll-to-bottom button */}
        {showScrollBtn && (
          <button
            type="button"
            onClick={handleScrollToBottom}
            style={{
              position:      'absolute',
              right:         12,
              bottom:        12,
              zIndex:        20,
              background:    'rgba(255,255,255,0.92)',
              color:         '#3f3f46',
              border:        '1px solid #e4e4e7',
              borderRadius:  6,
              padding:       '5px 10px',
              fontFamily:    TERMINAL_FONT_FAMILY,
              fontSize:      11,
              cursor:        'pointer',
              letterSpacing: '0.01em',
              display:       'flex',
              alignItems:    'center',
              gap:           4,
              boxShadow:     '0 1px 4px rgba(0,0,0,0.08)',
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12l7 7 7-7"/>
            </svg>
            Scroll to bottom
          </button>
        )}
      </div>
    )
  }
)

export default TerminalRenderer
