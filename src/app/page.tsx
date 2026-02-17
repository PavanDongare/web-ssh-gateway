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

// LocalStorage keys
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
    // Don't save duplicates
    const exists = saved.some(s => s.host === config.host && s.username === config.username)
    if (!exists) {
      saved.push(config)
      localStorage.setItem(SAVED_CONNECTIONS_KEY, JSON.stringify(saved))
    }
  } catch {
    // Ignore localStorage errors
  }
}

function removeConnection(config: ConnectionConfig) {
  try {
    const saved = getSavedConnections()
    const filtered = saved.filter(s => !(s.host === config.host && s.username === config.username))
    localStorage.setItem(SAVED_CONNECTIONS_KEY, JSON.stringify(filtered))
  } catch {
    // Ignore localStorage errors
  }
}

export default function Home() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [savedConnections, setSavedConnections] = useState<ConnectionConfig[]>([])

  // Load saved connections on mount
  useEffect(() => {
    const saved = getSavedConnections()
    setSavedConnections(saved)
    
    // Auto-connect to saved connections
    if (saved.length > 0) {
      // Create tabs for saved connections
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
      if (newTabs.length > 0) {
        setActiveTabId(newTabs[0].id)
      }
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

    // Save to localStorage
    saveConnection(config)
    setSavedConnections(getSavedConnections())

    setTabs((prev) => [...prev, newTab])
    setActiveTabId(tabId)
    setIsModalOpen(false)
  }, [])

  const handleDeleteConnection = useCallback((config: ConnectionConfig) => {
    removeConnection(config)
    setSavedConnections(getSavedConnections())
  }, [])

  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const newTabs = prev.filter((tab) => tab.id !== tabId)
      if (activeTabId === tabId) {
        setActiveTabId(newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null)
      }
      return newTabs
    })
  }, [activeTabId])

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      {/* Header */}
      <header className="bg-gray-800 border-b border-gray-700 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <h1 className="text-lg font-semibold text-white">WebSSH Gateway</h1>
          </div>
          <button
            onClick={() => setIsModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors font-medium"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span className="hidden sm:inline">New Connection</span>
          </button>
        </div>
      </header>

      {/* Saved Connections Bar */}
      {savedConnections.length > 0 && (
        <div className="bg-gray-800 border-b border-gray-700 px-4 py-2 flex items-center gap-2 overflow-x-auto">
          <span className="text-xs text-gray-400 whitespace-nowrap">Saved:</span>
          {savedConnections.map((conn, idx) => (
            <button
              key={idx}
              onClick={() => {
                // Check if already connected
                const exists = tabs.some(t => t.host === conn.host && t.username === conn.username)
                if (!exists) {
                  handleConnect(conn)
                }
              }}
              className="px-3 py-1 bg-gray-700 text-gray-300 text-xs rounded-full hover:bg-gray-600 whitespace-nowrap flex items-center gap-1"
            >
              {conn.username}@{conn.host}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleDeleteConnection(conn)
                }}
                className="ml-1 text-gray-500 hover:text-red-400"
              >
                ×
              </button>
            </button>
          ))}
        </div>
      )}

      {/* Tab Bar */}
      {tabs.length > 0 && (
        <div className="bg-gray-800 border-b border-gray-700 flex overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`group flex items-center gap-2 px-4 py-2 border-r border-gray-700 cursor-pointer min-w-max ${
                activeTabId === tab.id
                  ? 'bg-gray-900 text-white border-t-2 border-t-blue-500'
                  : 'text-gray-400 hover:text-white hover:bg-gray-750'
              }`}
              onClick={() => setActiveTabId(tab.id)}
            >
              <span className="text-sm font-medium">{tab.name}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
                className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-white transition-opacity"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {tabs.length > 0 ? (
          <div className="flex-1 p-4 flex flex-col overflow-hidden">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className="flex-1 flex flex-col overflow-hidden"
                style={{ 
                  display: tab.id === activeTabId ? 'flex' : 'none',
                  visibility: tab.id === activeTabId ? 'visible' : 'hidden',
                  position: tab.id === activeTabId ? 'relative' : 'absolute',
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
          <div className="flex-1 flex flex-col items-center justify-center text-gray-400 p-4">
            <div className="w-24 h-24 bg-gray-800 rounded-full flex items-center justify-center mb-6">
              <svg className="w-12 h-12 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-gray-300 mb-2">No Active Connections</h2>
            <p className="text-center mb-6 max-w-md">Click "New Connection" or select a saved connection above.</p>
            <button
              onClick={() => setIsModalOpen(true)}
              className="flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors font-medium"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Create New Connection
            </button>
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