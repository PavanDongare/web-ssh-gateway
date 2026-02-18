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

  // Button label and style vary by status
  const label = {
    idle:         '🎙 Hold to speak',
    loading:      '⏳ Loading...',
    recording:    '🔴 Recording...',
    transcribing: '⏳ ...',
  }[status]

  const isRecording = status === 'recording'
  const isDisabled  = status === 'transcribing' || status === 'loading'

  return (
    <button
      type="button"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}   // release if pointer leaves button
      disabled={isDisabled}
      style={{
        position:     'absolute',
        right:        12,
        bottom:       56,
        zIndex:       20,
        background:   isRecording ? 'rgba(180,30,30,0.75)' : 'rgba(0,0,0,0.55)',
        color:        '#fff',
        border:       '1px solid rgba(255,255,255,0.18)',
        borderRadius: 10,
        padding:      '6px 10px',
        fontFamily:   TERMINAL_FONT_FAMILY,
        fontSize:     12,
        cursor:       isDisabled ? 'default' : 'pointer',
        userSelect:   'none',
        animation:    isRecording ? 'vt-pulse 1s ease-in-out infinite' : 'none',
        opacity:      isDisabled ? 0.7 : 1,
      }}
    >
      {label}
      {/* Inline keyframes for pulse animation */}
      <style>{`
        @keyframes vt-pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.6; }
        }
      `}</style>
    </button>
  )
}
