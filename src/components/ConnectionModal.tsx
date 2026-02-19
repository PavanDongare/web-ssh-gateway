'use client'

import { useState } from 'react'

interface ConnectionModalProps {
  isOpen: boolean
  onClose: () => void
  onConnect: (config: ConnectionConfig) => void
}

export type ConnectionMode = 'ssh' | 'local'

export interface ConnectionConfig {
  mode: ConnectionMode
  name?: string
  host?: string
  port?: number
  username?: string
  password?: string
  privateKey?: string
  passphrase?: string
  authMethod: 'password' | 'key'
}

export default function ConnectionModal({
  isOpen,
  onClose,
  onConnect,
}: ConnectionModalProps) {
  const [mode, setMode] = useState<ConnectionMode>('ssh')
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('')
  const [authMethod, setAuthMethod] = useState<'password' | 'key'>('password')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')

  const handleConnect = () => {
    if (mode === 'ssh') {
      if (!host || !username) { alert('Host and username are required'); return }
      if (authMethod === 'password' && !password) { alert('Password is required'); return }
      if (authMethod === 'key' && !privateKey) { alert('Private key is required'); return }
    }

    onConnect({
      mode,
      name: name.trim() || undefined,
      host: mode === 'ssh' ? host : undefined,
      port: mode === 'ssh' ? (parseInt(port) || 22) : undefined,
      username: mode === 'ssh' ? username : undefined,
      password: authMethod === 'password' ? password : undefined,
      privateKey: authMethod === 'key' ? privateKey : undefined,
      passphrase: authMethod === 'key' ? passphrase : undefined,
      authMethod,
    })

    setMode('ssh')
    setName('')
    setHost(''); setPort('22'); setUsername('')
    setPassword(''); setPrivateKey(''); setPassphrase('')
    onClose()
  }

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)' }}
    >
      <div className="bg-white border border-[#e4e4e7] rounded-xl shadow-xl w-full max-w-md">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#e4e4e7]">
          <div>
            <h2 className="text-sm font-semibold text-[#09090b]">New Connection</h2>
            <p className="text-xs text-[#71717a] mt-0.5">
              {mode === 'ssh' ? 'Connect to an SSH server' : 'Open a local shell on this host'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-[#a1a1aa] hover:text-[#09090b] hover:bg-[#f4f4f5] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[#3f3f46]">Mode</label>
            <div className="flex bg-[#f4f4f5] border border-[#e4e4e7] rounded-md p-0.5">
              <button
                type="button"
                onClick={() => setMode('ssh')}
                className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors duration-150 ${
                  mode === 'ssh'
                    ? 'bg-white text-[#09090b] shadow-sm border border-[#e4e4e7]'
                    : 'text-[#71717a] hover:text-[#3f3f46]'
                }`}
              >
                SSH
              </button>
              <button
                type="button"
                onClick={() => setMode('local')}
                className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors duration-150 ${
                  mode === 'local'
                    ? 'bg-white text-[#09090b] shadow-sm border border-[#e4e4e7]'
                    : 'text-[#71717a] hover:text-[#3f3f46]'
                }`}
              >
                Local Terminal
              </button>
            </div>
          </div>

          {mode === 'local' && (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-[#3f3f46]">
                Session Name
                <span className="ml-1 text-[#a1a1aa] font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Local Shell"
                className="w-full px-3 py-2 bg-white border border-[#e4e4e7] rounded-md text-sm text-[#09090b] placeholder-[#a1a1aa] focus:outline-none focus:ring-1 focus:ring-[#09090b] focus:border-[#09090b] transition-colors"
              />
            </div>
          )}

          {mode === 'ssh' && (
            <>
              {/* Host & Port */}
              <div className="flex gap-3">
                <div className="flex-1 space-y-1.5">
                  <label className="block text-xs font-medium text-[#3f3f46]">Host</label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="192.168.1.100"
                    className="w-full px-3 py-2 bg-white border border-[#e4e4e7] rounded-md text-sm text-[#09090b] placeholder-[#a1a1aa] focus:outline-none focus:ring-1 focus:ring-[#09090b] focus:border-[#09090b] transition-colors font-mono"
                  />
                </div>
                <div className="w-20 space-y-1.5">
                  <label className="block text-xs font-medium text-[#3f3f46]">Port</label>
                  <input
                    type="text"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="22"
                    className="w-full px-3 py-2 bg-white border border-[#e4e4e7] rounded-md text-sm text-[#09090b] placeholder-[#a1a1aa] focus:outline-none focus:ring-1 focus:ring-[#09090b] focus:border-[#09090b] transition-colors font-mono"
                  />
                </div>
              </div>

              {/* Username */}
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-[#3f3f46]">Username</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="root"
                  className="w-full px-3 py-2 bg-white border border-[#e4e4e7] rounded-md text-sm text-[#09090b] placeholder-[#a1a1aa] focus:outline-none focus:ring-1 focus:ring-[#09090b] focus:border-[#09090b] transition-colors font-mono"
                />
              </div>

              {/* Auth Method — segmented control */}
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-[#3f3f46]">Authentication</label>
                <div className="flex bg-[#f4f4f5] border border-[#e4e4e7] rounded-md p-0.5">
                  <button
                    type="button"
                    onClick={() => setAuthMethod('password')}
                    className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors duration-150 ${
                      authMethod === 'password'
                        ? 'bg-white text-[#09090b] shadow-sm border border-[#e4e4e7]'
                        : 'text-[#71717a] hover:text-[#3f3f46]'
                    }`}
                  >
                    Password
                  </button>
                  <button
                    type="button"
                    onClick={() => setAuthMethod('key')}
                    className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors duration-150 ${
                      authMethod === 'key'
                        ? 'bg-white text-[#09090b] shadow-sm border border-[#e4e4e7]'
                        : 'text-[#71717a] hover:text-[#3f3f46]'
                    }`}
                  >
                    SSH Key
                  </button>
                </div>
              </div>

              {/* Password field */}
              {authMethod === 'password' ? (
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-[#3f3f46]">Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full px-3 py-2 bg-white border border-[#e4e4e7] rounded-md text-sm text-[#09090b] placeholder-[#a1a1aa] focus:outline-none focus:ring-1 focus:ring-[#09090b] focus:border-[#09090b] transition-colors"
                  />
                </div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-[#3f3f46]">Private Key</label>
                    <textarea
                      value={privateKey}
                      onChange={(e) => setPrivateKey(e.target.value)}
                      placeholder={`-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----`}
                      rows={4}
                      className="w-full px-3 py-2 bg-white border border-[#e4e4e7] rounded-md text-xs text-[#09090b] placeholder-[#a1a1aa] focus:outline-none focus:ring-1 focus:ring-[#09090b] focus:border-[#09090b] transition-colors font-mono resize-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-[#3f3f46]">
                      Passphrase
                      <span className="ml-1 text-[#a1a1aa] font-normal">(optional)</span>
                    </label>
                    <input
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder="Key passphrase"
                      className="w-full px-3 py-2 bg-white border border-[#e4e4e7] rounded-md text-sm text-[#09090b] placeholder-[#a1a1aa] focus:outline-none focus:ring-1 focus:ring-[#09090b] focus:border-[#09090b] transition-colors"
                    />
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2 px-5 py-4 border-t border-[#e4e4e7]">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-white border border-[#e4e4e7] text-[#3f3f46] text-sm font-medium rounded-md hover:bg-[#f4f4f5] hover:text-[#09090b] transition-colors duration-150"
          >
            Cancel
          </button>
          <button
            onClick={handleConnect}
            className="flex-1 px-4 py-2 bg-[#09090b] text-white text-sm font-medium rounded-md hover:bg-[#27272a] transition-colors duration-150"
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  )
}
