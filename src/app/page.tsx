'use client'

import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import Terminal from '@/components/Terminal'
import ConnectionModal, { ConnectionConfig, type ConnectionMode } from '@/components/ConnectionModal'

interface Tab {
  id: string
  name: string
  mode: ConnectionMode
  host?: string
  port?: number
  username?: string
  password?: string
  privateKey?: string
  passphrase?: string
}

const SAVED_CONNECTIONS_KEY = 'webssh_saved_connections'
const LOCAL_TAB_ID = 'local-machine-terminal'

function getSavedConnections(): ConnectionConfig[] {
  if (typeof window === 'undefined') return []
  try {
    const saved = localStorage.getItem(SAVED_CONNECTIONS_KEY)
    return saved ? JSON.parse(saved) : []
  } catch {
    return []
  }
}

function saveConnection(config: ConnectionConfig) {
  if (config.mode !== 'ssh' || !config.host || !config.username) return
  try {
    const saved = getSavedConnections()
    const exists = saved.some(
      s => (s.mode ?? 'ssh') === 'ssh' && s.host === config.host && s.username === config.username
    )
    if (!exists) {
      saved.push(config)
      localStorage.setItem(SAVED_CONNECTIONS_KEY, JSON.stringify(saved))
    }
  } catch {}
}

function removeConnection(config: ConnectionConfig) {
  if (config.mode !== 'ssh' || !config.host || !config.username) return
  try {
    const saved = getSavedConnections()
    const filtered = saved.filter(
      s => !(s.host === config.host && s.username === config.username && (s.mode ?? 'ssh') === 'ssh')
    )
    localStorage.setItem(SAVED_CONNECTIONS_KEY, JSON.stringify(filtered))
  } catch {}
}

function toSshCommand(config: ConnectionConfig): string {
  const host = config.host ?? ''
  const username = config.username ?? ''
  const port = config.port && config.port !== 22 ? ` -p ${config.port}` : ''
  return `ssh${port} ${username}@${host}`.trim()
}

export default function Home() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSavedPanelOpen, setIsSavedPanelOpen] = useState(false)
  const [savedConnections, setSavedConnections] = useState<ConnectionConfig[]>([])

  useEffect(() => {
    const saved = getSavedConnections().map(conn => ({
      ...conn,
      mode: conn.mode ?? 'ssh',
    }))
    setSavedConnections(saved)
  }, [])

  const handleConnect = useCallback((config: ConnectionConfig) => {
    const mode = config.mode ?? 'ssh'
    const tabId = mode === 'local' ? LOCAL_TAB_ID : `tab-${Date.now()}`

    if (mode === 'local') {
      const existingLocal = tabs.find(t => t.mode === 'local')
      if (existingLocal) {
        setActiveTabId(existingLocal.id)
        setIsModalOpen(false)
        return
      }
    }

    const newTab: Tab = {
      id: tabId,
      mode,
      name:
        mode === 'local'
          ? (config.name?.trim() || 'local-terminal')
          : `${config.username}@${config.host}`,
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      privateKey: config.privateKey,
      passphrase: config.passphrase,
    }
    saveConnection(config)
    setSavedConnections(getSavedConnections())
    setTabs(prev => [...prev, newTab])
    setActiveTabId(tabId)
    setIsModalOpen(false)
  }, [tabs])

  const handleDeleteConnection = useCallback((config: ConnectionConfig) => {
    removeConnection(config)
    setSavedConnections(getSavedConnections())
  }, [])

  const handleCopySshCommand = useCallback(async (config: ConnectionConfig) => {
    const command = toSshCommand(config)
    try {
      await navigator.clipboard.writeText(command)
    } catch {
      // Clipboard may be blocked by browser permissions; keep UI silent.
    }
  }, [])

  const openLocalFromPanel = useCallback(() => {
    const existingLocal = tabs.find(t => t.mode === 'local')
    if (existingLocal) {
      setActiveTabId(existingLocal.id)
    } else {
      handleConnect({
        mode: 'local',
        name: 'local-terminal',
        authMethod: 'password',
      })
    }
    setIsSavedPanelOpen(false)
  }, [handleConnect, tabs])

  const openSshFromPanel = useCallback((conn: ConnectionConfig) => {
    const existing = tabs.find(
      t => t.mode === 'ssh' && t.host === conn.host && t.username === conn.username
    )
    if (existing) {
      setActiveTabId(existing.id)
    } else {
      handleConnect(conn)
    }
    setIsSavedPanelOpen(false)
  }, [handleConnect, tabs])

  const closeTab = useCallback((tabId: string) => {
    setTabs(prev => {
      const newTabs = prev.filter(tab => tab.id !== tabId)
      if (activeTabId === tabId) {
        setActiveTabId(newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null)
      }
      return newTabs
    })
  }, [activeTabId])

  return (
    <div className="h-full bg-white flex flex-col overflow-hidden">

      {/* Header */}
      <header className="bg-white border-b border-[#e4e4e7] px-4 h-12 flex items-center">
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 bg-[#09090b] rounded flex items-center justify-center flex-shrink-0">
              <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <span className="text-sm font-semibold text-[#09090b] tracking-tight">WebSSH Gateway</span>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/help"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#e4e4e7] text-[#3f3f46] text-xs font-medium rounded-md hover:bg-[#f4f4f5] hover:text-[#09090b] transition-colors duration-150"
            >
              Help
            </Link>
            <button
              onClick={() => setIsModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#09090b] text-white text-xs font-medium rounded-md hover:bg-[#27272a] transition-colors duration-150"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
              </svg>
              <span className="hidden sm:inline">New Connection</span>
            </button>
            <button
              type="button"
              onClick={() => setIsSavedPanelOpen(true)}
              className="md:hidden inline-flex items-center justify-center w-8 h-8 border border-[#e4e4e7] rounded-md text-[#3f3f46] hover:text-[#09090b] hover:bg-[#f4f4f5] transition-colors"
              title="Saved Connections"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 min-h-0 flex">
        {/* Main Pane */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Tab Bar */}
          {tabs.length > 0 && (
            <div className="bg-white border-b border-[#e4e4e7] flex overflow-x-auto">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`group flex items-center gap-2 px-4 py-2.5 border-r border-[#e4e4e7] cursor-pointer min-w-max transition-colors duration-150 ${
                    activeTabId === tab.id
                      ? 'bg-white text-[#09090b] border-b-2 border-b-[#09090b]'
                      : 'bg-[#f4f4f5] text-[#71717a] hover:text-[#3f3f46] hover:bg-[#fafafa]'
                  }`}
                  onClick={() => setActiveTabId(tab.id)}
                >
                  {activeTabId === tab.id && (
                    <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] flex-shrink-0" />
                  )}
                  <span className="text-xs font-mono font-medium">{tab.name}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(tab.id)
                    }}
                    className="opacity-0 group-hover:opacity-100 text-[#a1a1aa] hover:text-[#09090b] transition-all ml-1"
                    title="Close"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Main Content */}
          <main className="flex-1 flex flex-col overflow-hidden bg-[#f4f4f5]">
            {tabs.length > 0 ? (
              <div className="flex-1 relative overflow-hidden" style={{ padding: '0 0 0 0' }}>
                {tabs.map((tab) => (
                  <div
                    key={tab.id}
                    className="sm:rounded-lg sm:border sm:border-[#e4e4e7] sm:shadow-sm overflow-hidden"
                    style={{
                      position: 'absolute',
                      inset: 0,
                      margin: 'clamp(0px, 1.5vw, 12px)',
                      display: tab.id === activeTabId ? 'block' : 'none',
                    }}
                  >
                    <Terminal
                      key={tab.id}
                      tabId={tab.id}
                      mode={tab.mode}
                      host={tab.host}
                      port={tab.port ?? 22}
                      username={tab.username}
                      password={tab.password}
                      privateKey={tab.privateKey}
                      passphrase={tab.passphrase}
                    />
                  </div>
                ))}
              </div>
            ) : (
              /* Empty state */
              <div className="flex-1 flex flex-col items-center justify-center p-8">
                <div className="flex flex-col items-center gap-5 max-w-xs text-center">
                  <div className="w-14 h-14 bg-white border border-[#e4e4e7] rounded-xl flex items-center justify-center shadow-sm">
                    <svg className="w-7 h-7 text-[#d4d4d8]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <div className="space-y-1">
                    <h2 className="text-sm font-semibold text-[#09090b]">No active connections</h2>
                    <p className="text-xs text-[#71717a] leading-relaxed">
                      Create a new SSH connection to get started. Connections are saved locally.
                    </p>
                  </div>
                  <button
                    onClick={() => setIsModalOpen(true)}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-[#09090b] text-white text-sm font-medium rounded-md hover:bg-[#27272a] transition-colors duration-150"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                    </svg>
                    New Connection
                  </button>
                </div>
              </div>
            )}
          </main>
        </div>

        {/* Saved Connections Panel */}
        <aside className="hidden md:block w-64 shrink-0 border-l border-[#e4e4e7] bg-[#f4f4f5] p-3 overflow-y-auto">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[10px] font-semibold text-[#a1a1aa] uppercase tracking-widest whitespace-nowrap">
              Saved
            </span>
            <div className="w-px h-3 bg-[#d4d4d8]" />
          </div>
          <p className="text-[10px] text-[#71717a] mb-3 leading-relaxed">
            For Local mode speed tests: copy an SSH command, open <span className="font-mono">local</span>, and paste.
          </p>

          <div className="bg-white border border-[#e4e4e7] rounded overflow-hidden divide-y divide-[#e4e4e7]">
            <button
              onClick={openLocalFromPanel}
              className="w-full h-8 px-2.5 text-left text-[#3f3f46] text-xs hover:text-[#09090b] hover:bg-[#fafafa] transition-colors font-mono"
            >
              local
            </button>
            {savedConnections.map((conn, idx) => (
              <div
                key={idx}
                className="flex items-center"
              >
                <button
                  onClick={() => openSshFromPanel(conn)}
                  className="flex-1 h-8 px-2.5 text-[#3f3f46] text-xs hover:text-[#09090b] hover:bg-[#fafafa] whitespace-nowrap transition-colors font-mono text-left"
                >
                  {conn.username}@{conn.host}
                </button>
                <button
                  onClick={() => handleCopySshCommand(conn)}
                  className="h-8 px-2 text-[#a1a1aa] hover:text-[#09090b] hover:bg-[#fafafa] text-[11px] transition-colors border-l border-[#e4e4e7]"
                  title="Copy SSH command"
                >
                  copy
                </button>
                <button
                  onClick={() => handleDeleteConnection(conn)}
                  className="h-8 w-8 text-[#a1a1aa] hover:text-[#ef4444] hover:bg-[#fafafa] text-xs transition-colors border-l border-[#e4e4e7]"
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </aside>
      </div>

      {/* Mobile Saved Drawer */}
      {isSavedPanelOpen && (
        <div className="md:hidden fixed inset-0 z-50">
          <button
            type="button"
            onClick={() => setIsSavedPanelOpen(false)}
            className="absolute inset-0 bg-black/30"
            aria-label="Close saved panel"
          />
          <aside className="absolute right-0 top-0 h-full w-72 max-w-[88vw] border-l border-[#e4e4e7] bg-[#f4f4f5] p-3 overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-[#a1a1aa] uppercase tracking-widest whitespace-nowrap">
                  Saved
                </span>
                <div className="w-px h-3 bg-[#d4d4d8]" />
              </div>
              <button
                type="button"
                onClick={() => setIsSavedPanelOpen(false)}
                className="w-7 h-7 flex items-center justify-center rounded-md text-[#a1a1aa] hover:text-[#09090b] hover:bg-[#f4f4f5] transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <p className="text-[10px] text-[#71717a] mb-3 leading-relaxed">
              For Local mode speed tests: copy an SSH command, open <span className="font-mono">local</span>, and paste.
            </p>

            <div className="bg-white border border-[#e4e4e7] rounded overflow-hidden divide-y divide-[#e4e4e7]">
              <button
                onClick={openLocalFromPanel}
                className="w-full h-8 px-2.5 text-left text-[#3f3f46] text-xs hover:text-[#09090b] hover:bg-[#fafafa] transition-colors font-mono"
              >
                local
              </button>
              {savedConnections.map((conn, idx) => (
                <div
                  key={idx}
                  className="flex items-center"
                >
                  <button
                    onClick={() => openSshFromPanel(conn)}
                    className="flex-1 h-8 px-2.5 text-[#3f3f46] text-xs hover:text-[#09090b] hover:bg-[#fafafa] whitespace-nowrap transition-colors font-mono text-left"
                  >
                    {conn.username}@{conn.host}
                  </button>
                  <button
                    onClick={() => handleCopySshCommand(conn)}
                    className="h-8 px-2 text-[#a1a1aa] hover:text-[#09090b] hover:bg-[#fafafa] text-[11px] transition-colors border-l border-[#e4e4e7]"
                    title="Copy SSH command"
                  >
                    copy
                  </button>
                  <button
                    onClick={() => handleDeleteConnection(conn)}
                    className="h-8 w-8 text-[#a1a1aa] hover:text-[#ef4444] hover:bg-[#fafafa] text-xs transition-colors border-l border-[#e4e4e7]"
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </aside>
        </div>
      )}

      <ConnectionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onConnect={handleConnect}
      />
    </div>
  )
}
