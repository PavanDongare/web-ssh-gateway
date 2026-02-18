'use client'

import { useEffect, useRef, useState } from 'react'
import { TERMINAL_FONT_FAMILY } from '@/utils/terminal-constants'

// ---------------------------------------------------------------------------
// Module-level pipeline cache — survives re-renders, loaded once
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelineCache: Promise<any> | null = null

function getModel(): Promise<any> {
  if (!pipelineCache) {
    pipelineCache = import('@huggingface/transformers').then(({ pipeline }) =>
      pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en')
    )
  }
  return pipelineCache
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Status = 'idle' | 'loading' | 'recording' | 'transcribing'

interface VoiceInputProps {
  onTranscript: (text: string) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function VoiceInput({ onTranscript }: VoiceInputProps) {
  const [status, setStatus] = useState<Status>('idle')
  const recorderRef  = useRef<MediaRecorder | null>(null)
  const chunksRef    = useRef<Blob[]>([])
  const streamRef    = useRef<MediaStream | null>(null)

  // Pre-warm the model on mount so the first click is instant
  useEffect(() => { getModel().catch(() => {}) }, [])

  const handlePointerDown = async (e: React.PointerEvent) => {
    // Prevent focus being stolen from the terminal
    e.preventDefault()

    // Already recording — ignore double press
    if (status === 'recording' || status === 'loading' || status === 'transcribing') return

    setStatus('loading')

    try {
      // Model is already loading/loaded — just await the cached promise
      const model = await getModel()

      // Get mic access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // Start recording
      chunksRef.current = []
      const recorder = new MediaRecorder(stream)
      recorderRef.current = recorder

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data)
      }

      recorder.onstop = async () => {
        setStatus('transcribing')

        // Stop all mic tracks
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null

        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        chunksRef.current = []

        try {
          // Whisper expects Float32Array at 16kHz
          const arrayBuffer = await blob.arrayBuffer()
          const audioCtx = new AudioContext({ sampleRate: 16000 })
          const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer)
          await audioCtx.close()
          const float32 = audioBuffer.getChannelData(0)

          const result = await model(float32)
          const text = (result.text as string).trim()
          if (text) onTranscript(text + ' ')
        } catch (err) {
          console.error('[VoiceInput] transcription error:', err)
        }

        setStatus('idle')
      }

      recorder.start()
      setStatus('recording')
    } catch (err) {
      console.error('[VoiceInput] setup error:', err)
      setStatus('idle')
    }
  }

  const handlePointerUp = () => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop()
      recorderRef.current = null
    }
  }

  const isRecording = status === 'recording'
  const isDisabled  = status === 'transcribing' || status === 'loading'

  return (
    <button
      type="button"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      disabled={isDisabled}
      style={{
        position:      'absolute',
        right:         12,
        bottom:        56,
        zIndex:        20,
        background:    isRecording ? '#fef2f2' : 'rgba(255,255,255,0.92)',
        color:         isRecording ? '#dc2626' : '#3f3f46',
        border:        isRecording ? '1px solid #fca5a5' : '1px solid #e4e4e7',
        borderRadius:  6,
        padding:       '5px 10px',
        fontFamily:    TERMINAL_FONT_FAMILY,
        fontSize:      11,
        cursor:        isDisabled ? 'default' : 'pointer',
        userSelect:    'none',
        animation:     isRecording ? 'vt-pulse 1s ease-in-out infinite' : 'none',
        opacity:       isDisabled ? 0.5 : 1,
        display:       'flex',
        alignItems:    'center',
        gap:           5,
        letterSpacing: '0.01em',
        boxShadow:     '0 1px 4px rgba(0,0,0,0.08)',
      }}
    >
      {/* Icon */}
      {status === 'idle' && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      )}
      {status === 'recording' && (
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#dc2626', display: 'inline-block', flexShrink: 0 }} />
      )}
      {(status === 'loading' || status === 'transcribing') && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
        </svg>
      )}
      {status === 'idle' ? 'Hold to speak' : status === 'recording' ? 'Recording…' : status === 'loading' ? 'Loading…' : '…'}
      <style>{`
        @keyframes vt-pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.5; }
        }
      `}</style>
    </button>
  )
}
