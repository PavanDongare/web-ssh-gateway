'use client'

import { useState, useCallback, useEffect } from 'react'
import Terminal from '@/components/Terminal'
import ConnectionModal, { ConnectionConfig } from '@/components/ConnectionModal'

interface Tab {
  id: string
  name: string
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
}

const SAVED_CONNECTIONS_KEY = 'webssh_saved_connections'

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
  try {
    const saved = getSavedConnections()
    const exists = saved.some(s => s.host === config.host && s.username === config.username)
    if (!exists) {
      saved.push(config)
      localStorage.setItem(SAVED_CONNECTIONS_KEY, JSON.stringify(saved))
    }
  } catch {}
}

function removeConnection(config: ConnectionConfig) {
  try {
    const saved = getSavedConnections()
    const filtered = saved.filter(s => !(s.host === config.host && s.username === config.username))
    localStorage.setItem(SAVED_CONNECTIONS_KEY, JSON.stringify(filtered))
  } catch {}
}

export default function Home() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [savedConnections, setSavedConnections] = useState<ConnectionConfig[]>([])

  useEffect(() => {
    const saved = getSavedConnections()
    setSavedConnections(saved)
    if (saved.length > 0) {
      const newTabs: Tab[] = saved.map((config, idx) => ({
        id: `saved-${idx}-${Date.now()}`,
        name: `${config.username}@${config.host}`,
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        privateKey: config.privateKey,
        passphrase: config.passphrase,
      }))
      setTabs(newTabs)
      setActiveTabId(newTabs[0].id)
    }
  }, [])

  const handleConnect = useCallback((config: ConnectionConfig) => {
    const tabId = `tab-${Date.now()}`
    const newTab: Tab = {
      id: tabId,
      name: `${config.username}@${config.host}`,
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
  }, [])

  const handleDeleteConnection = useCallback((config: ConnectionConfig) => {
    removeConnection(config)
    setSavedConnections(getSavedConnections())
  }, [])

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

          <button
            onClick={() => setIsModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#09090b] text-white text-xs font-medium rounded-md hover:bg-[#27272a] transition-colors duration-150"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
            </svg>
            <span className="hidden sm:inline">New Connection</span>
          </button>
        </div>
      </header>

      {/* Saved Connections Bar */}
      {savedConnections.length > 0 && (
        <div className="bg-[#f4f4f5] border-b border-[#e4e4e7] px-4 py-2 flex items-center gap-2 overflow-x-auto">
          <span className="text-[10px] font-semibold text-[#a1a1aa] uppercase tracking-widest whitespace-nowrap">
            Saved
          </span>
          <div className="w-px h-3 bg-[#d4d4d8]" />
          {savedConnections.map((conn, idx) => (
            <div
              key={idx}
              className="flex items-center bg-white border border-[#e4e4e7] rounded overflow-hidden shadow-sm"
            >
              <button
                onClick={() => {
                  const exists = tabs.some(t => t.host === conn.host && t.username === conn.username)
                  if (!exists) handleConnect(conn)
                }}
                className="px-2.5 py-1 text-[#3f3f46] text-xs hover:text-[#09090b] whitespace-nowrap transition-colors font-mono"
              >
                {conn.username}@{conn.host}
              </button>
              <button
                onClick={() => handleDeleteConnection(conn)}
                className="px-2 py-1 text-[#a1a1aa] hover:text-[#ef4444] text-xs transition-colors border-l border-[#e4e4e7]"
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

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
                  host={tab.host}
                  port={tab.port}
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

      <ConnectionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onConnect={handleConnect}
      />
    </div>
  )
}
